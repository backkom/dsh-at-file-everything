/**
 * Everything-backed `@file` completion for DeepSeek Harness on Windows.
 *
 * This package replaces `@deepseek-ai/dsh-file-reference-local`. That provider
 * answers `@` from a workspace walk it performs itself, bounded by
 * `maxEntries`; in a large tree the walk is both slow and lossy, because
 * generated output exhausts the budget before the sources are reached, and the
 * first `@` of a session waits for a full traversal.
 *
 * Everything already maintains that index for every fixed drive as a Windows
 * service, so this provider answers from it and performs no traversal at all.
 * The agent's working directory is a *scope and ranking* root rather than a
 * crawl root: the query is confined with `-path`, results are rendered relative
 * to it, and the shipped provider's tiering decides order, so `@` behaviour is
 * unchanged while latency and coverage are not.
 *
 * The service is provided by subclassing the seam's own `FileReferenceService`,
 * which is what makes this a drop-in: every dependent (the Session Controller's
 * `fileReferences/list` Remote, the Web composer) keeps resolving the same
 * service name. The composition must disable `file-reference-local`, because
 * Cordis refuses two providers of one name in a scope.
 *
 * @module dsh-at-file-everything
 */

import type { Agent, Context } from '@deepseek-ai/cordis'
import FileReferenceService, { FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
import z, { type Schema } from '@deepseek-ai/schemastery'

import {
  EsClient,
  contiguousTerm,
  folderExclusionTerms,
  fileExclusionTerms,
  listingTerm,
  subsequenceTerm,
  type EsFailure,
  type EsRow,
} from './es-client.js'
import {
  basenameOf,
  filterExcluded,
  isWithin,
  rank,
  relativeToRoot,
  toWindowsPath,
  type Candidate,
  type RawCandidate,
} from './candidates.js'
import { resolveEsCommands } from './resolve.js'
import { STATUS_ROUTE, esStatus, esVersion, statusBody } from './status.js'
import { buildFindFilesTool, makeFindFilesHost, FILE_SEARCH_PROMPT } from './tool.js'
import {
  DEFAULT_CONFIG,
  DEFAULT_EXCLUDED_DIRECTORIES,
  currentValue,
  normalizeConfig,
  type Config as ConfigShape,
} from './config.js'

// The pure helpers are re-exported from the package root as well, so a consumer
// that already resolves the plugin can reach them without a second specifier.
export {
  basenameOf,
  filterExcluded,
  isWithin,
  rank,
  relativeToRoot,
  toWindowsPath,
} from './candidates.js'
export { contiguousTerm, folderExclusionTerms, fileExclusionTerms, listingTerm, parseCsv, subsequenceTerm } from './es-client.js'
export { bundledEsCommand, resolveEsCommands } from './resolve.js'
export { STATUS_ROUTE, esStatus, esVersion, statusBody } from './status.js'
export { buildFindFilesTool, failureToError, renderFindFiles, TOOL_NAME, FILE_SEARCH_PROMPT } from './tool.js'

export type { Candidate, RawCandidate } from './candidates.js'
export type { EsFailure, EsRow } from './es-client.js'
export type { EsCandidate, EsSource } from './resolve.js'
export type { EsStatus, EsStatusEntry } from './status.js'
export type { FindFilesResult, FindFilesHost, FoundEntry } from './tool.js'

/** Cordis plugin name; also the loader entry id. */
export const name = 'dsh-at-file-everything'

/**
 * Services required before load.
 *
 * `agents` supplies per-agent roots and the model-guidance hook;
 * `workingDirectory` resolves each session's current directory.
 */
export const inject = ['agents', 'workingDirectory']

/**
 * Configuration schema with defaults; the Loader applies it at load time.
 *
 * Every field is `volatile`. The Harness serves settings forms only for
 * `volatile` fields, so a plain field would leave this plugin with no
 * configuration surface at all — and a volatile field is also the one that can
 * change without remounting the plugin, which is what makes the exclusion lists
 * editable from the Plugins page while `@` keeps working.
 */
export const Config: Schema<ConfigShape> = z.object({
  esCommand: z.string().default('es.exe').volatile(),
  maxResults: z.number().step(1).min(1).default(20).volatile(),
  maxCandidates: z.number().step(1).min(1).default(300).volatile(),
  timeoutMs: z.number().step(1).min(1).default(10000).volatile(),
  deadlineMs: z.number().step(1).min(1).default(25000).volatile(),
  excludedDirectories: z.array(z.string()).default([...DEFAULT_EXCLUDED_DIRECTORIES]).volatile(),
  excludeInQuery: z.array(z.string()).default([]).volatile(),
  excludeFilePatterns: z.array(z.string()).default([]).volatile(),
  fuzzyFallback: z.boolean().default(true).volatile(),
  extraPathDirectories: z.array(z.string()).default([]).volatile(),
  installPrompt: z.boolean().default(true).volatile(),
}) as Schema<ConfigShape>

/** Per-agent query state, discarded when the plugin unloads. */
interface AgentState {
  /** Root the cached client was built for. */
  cwd: string
  /** Everything client for that root. */
  client: EsClient
}

/**
 * Everything-backed implementation of `ctx.fileReferences`.
 *
 * The seam's service name is what dependents resolve, so providing this class in
 * place of the shipped provider needs no change anywhere else in the
 * composition.
 */
export class EverythingFileReferenceService extends FileReferenceService {
  /**
   * Live configuration.
   *
   * Read through {@link current} rather than snapshotted, because the fields are
   * `volatile`: the Loader hands over a live handle whose `.get()` is the value
   * in effect, and that is what makes an edit on the browser card apply without
   * remounting the plugin. A snapshot taken in the constructor would pin the
   * first value forever.
   */
  private readonly settings: ConfigShape
  private readonly states = new WeakMap<Agent, AgentState>()
  private readonly prompts = new Map<Agent, { dispose(): Promise<void> }>()

  /**
   * Whether the `find_files` tool is registered, which is what decides if the
   * model is told about it.
   *
   * A mutable flag rather than a constructor argument: the tool is registered by
   * `apply` after this service exists, and the prompt text is resolved at
   * assembly time, so flipping this afterwards is enough.
   */
  public searchPrompt = false

  /**
   * @param ctx - host Cordis context.
   * @param config - validated configuration with schema defaults applied.
   */
  constructor(ctx: Context, config: ConfigShape) {
    super(ctx)
    this.settings = config

    // Wiring is unconditional even when `installPrompt` is off: each section
    // decides its own text at assembly time, and the `find_files` guidance is not
    // optional — a user who turned off the `@path` section must still get a model
    // that knows the tool exists.
    for (const agent of ctx.agents.list()) this.installPrompt(agent)
    ctx.on('agent/created', ((event: { agent: Agent }) => {
      this.installPrompt(event.agent)
    }) as never)
    ctx.on('agent/disposed', ((event: { agent: Agent }) => {
      const fiber = this.prompts.get(event.agent)
      if (fiber === undefined) return
      this.prompts.delete(event.agent)
      void fiber.dispose()
    }) as never)

    ctx.effect(
      () => async () => {
        const fibers = [...this.prompts.values()]
        this.prompts.clear()
        await Promise.allSettled(fibers.map((fiber) => fiber.dispose()))
      },
      'dsh-at-file-everything: prompt fibers',
    )
  }

  /**
   * Read one configuration field as it stands now.
   *
   * A `volatile` field reaches the plugin as a live handle (an object with
   * `.get()`) rather than a value, which is exactly what lets a card edit apply
   * without remounting. A plain value — which is what a direct `apply()` call and
   * an older Loader hand over — is returned as-is.
   *
   * Public because the tool needs the same live reads as the provider: both must
   * see an edited configuration without a remount.
   *
   * @param key - the Config field name.
   * @returns the value currently in effect.
   */
  live<K extends keyof ConfigShape>(key: K): ConfigShape[K] {
    const value = currentValue(this.settings[key])
    return (value === undefined ? DEFAULT_CONFIG[key] : value) as ConfigShape[K]
  }

  /** The directories dropped from returned rows, lower-cased for comparison. */
  private excludedSet(): Set<string> {
    return new Set(this.live('excludedDirectories').map((entry) => entry.toLowerCase()))
  }

  /**
   * Answer one `@` query for an agent.
   *
   * A query containing `/` is directory-scoped and lists that one directory, so
   * descending a deep tree costs one cheap lookup per level. A bare query
   * searches the whole root through Everything's index.
   *
   * A failure in the search backend answers an empty list rather than throwing:
   * a broken Everything service must not break the composer, and the reason is
   * logged instead.
   *
   * @param agent - agent whose working directory scopes the search.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns ranked path-only candidates.
   */
  override async list(agent: Agent, query: string, signal: AbortSignal): Promise<Candidate[]> {
    if (signal.aborted) return []
    try {
      const state = await this.stateFor(agent, signal)
      if (state === undefined || signal.aborted) return []

      const normalized = query.replaceAll('\\', '/')
      const slash = normalized.lastIndexOf('/')
      if (normalized === '' || slash >= 0) {
        return await this.listDirectory(state, normalized.slice(0, slash + 1), normalized.slice(slash + 1), signal)
      }
      return await this.listWorkspace(state, normalized, signal)
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-at-file-everything: query failed: ${describe(error)}`)
      return []
    }
  }

  /** Resolve one agent's root and client, following working-directory changes. */
  private async stateFor(agent: Agent, signal: AbortSignal): Promise<AgentState | undefined> {
    const cwd = normalizeRoot(await this.ctx.workingDirectory.ensure(agent, signal))
    if (signal.aborted) return undefined
    const existing = this.states.get(agent)
    if (existing !== undefined && existing.cwd === cwd) return existing
    const candidates = resolveEsCommands(this.live('esCommand'), this.live('extraPathDirectories'))
    if (candidates.length === 0) {
      this.ctx.logger?.warn?.(
        'dsh-at-file-everything: no es.exe found (checked the configured path, PATH, and the bundled copy)',
      )
    }
    const state: AgentState = {
      cwd,
      client: new EsClient(candidates.map((candidate) => candidate.path), {
        timeoutMs: this.live('timeoutMs'),
        deadlineMs: this.live('deadlineMs'),
        extraPathDirectories: this.live('extraPathDirectories'),
      }),
    }
    this.states.set(agent, state)
    return state
  }

  /** List one directory's entries, filtered by an optional fragment. */
  private async listDirectory(
    state: AgentState,
    directory: string,
    fragment: string,
    signal: AbortSignal,
  ): Promise<Candidate[]> {
    const excluded = this.excludedSet()
    const segments = directory.split('/').filter(Boolean)
    if (segments.some((segment) => excluded.has(segment.toLowerCase()))) return []

    // Refuse a path that leaves the workspace. `@../other/` would otherwise be
    // joined onto the root and handed to Everything, turning completion into a
    // reader for any indexed directory on the machine — the same failure mode
    // as an unscoped query, just spelled as a relative path.
    const absolute = toWindowsPath(state.cwd, segments)
    if (!isWithin(state.cwd, absolute)) return []

    // The fragment goes to Everything as a term rather than being applied to the
    // returned page. `-n` caps the rows that come back, so filtering afterwards
    // would silently drop every entry whose name sorts past the cap: a directory
    // holding 4 724 children answers nothing for a name near the end of the
    // alphabet — the same class of failure this provider exists to remove.
    const found = await state.client.query(
      ['-parent', absolute, '-n', String(this.live('maxCandidates')), listingTerm(fragment)],
      signal,
    )
    if (!Array.isArray(found)) {
      this.report(found)
      return []
    }

    const rows: RawCandidate[] = []
    for (const row of found) {
      const entryName = basenameOf(row.path)
      if (entryName === undefined) continue
      // Match the shipped provider: dot-entries appear only once the user has
      // typed a leading dot for them.
      if (entryName.startsWith('.') && !fragment.startsWith('.')) continue
      if (row.directory && excluded.has(entryName.toLowerCase())) continue
      rows.push({
        path: `${directory}${entryName}`,
        name: entryName,
        kind: row.directory ? 'directory' : 'file',
      })
    }
    return rank(rows, directory + fragment, this.live('maxResults'))
  }

  /**
   * Search the whole root through Everything's index.
   *
   * The fuzzy tier runs only when the contiguous tier matched **nothing at all**,
   * not when it merely contributed no *visible* rows. Those differ: a query whose
   * only hits sit under an excluded directory (e.g. `PlayablePrefab`, whose
   * matches are all in `Output/` and `Library/`) is a query the user already
   * spelled correctly, and re-asking Everything with a subsequence pattern would
   * cost ~800 ms to rediscover the same hidden files.
   */
  private async listWorkspace(state: AgentState, query: string, signal: AbortSignal): Promise<Candidate[]> {
    const scope = [
      '-path',
      state.cwd,
      '-n',
      String(this.live('maxCandidates')),
      ...folderExclusionTerms(this.live('excludeInQuery')),
      ...fileExclusionTerms(this.live('excludeFilePatterns')),
    ]

    const found = await state.client.query([...scope, contiguousTerm(query)], signal)
    if (!Array.isArray(found)) {
      this.report(found)
      return []
    }
    let rows = this.toRawCandidates(state.cwd, found, query)

    if (found.length === 0 && this.live('fuzzyFallback') && !signal.aborted) {
      const fuzzy = await state.client.query([...scope, subsequenceTerm(query)], signal)
      if (!Array.isArray(fuzzy)) {
        this.report(fuzzy)
        return []
      }
      rows = this.toRawCandidates(state.cwd, fuzzy, query)
    }

    return rank(filterExcluded(rows, this.excludedSet()), query, this.live('maxResults'))
  }

  /** Convert Everything rows into root-relative candidates. */
  private toRawCandidates(root: string, found: EsRow[], query: string): RawCandidate[] {
    const hiddenAllowed = query.startsWith('.') || query.includes('/.')
    const rows: RawCandidate[] = []
    for (const row of found) {
      const relative = relativeToRoot(root, row.path)
      if (relative === undefined) continue
      const entryName = basenameOf(relative)
      if (entryName === undefined) continue
      if (!hiddenAllowed && relative.split('/').some((segment) => segment.startsWith('.'))) continue
      rows.push({ path: relative, name: entryName, kind: row.directory ? 'directory' : 'file' })
    }
    return rows
  }

  /**
   * Log a search-backend failure that degraded to an empty answer.
   *
   * "Everything is not running" is called out separately because it is the one
   * cause an empty `@` list misrepresents: the index is complete, nothing is
   * answering it, and the fix is to launch a program. Every other reason is a
   * genuine inability to search.
   */
  private report(failure: EsFailure): void {
    if (failure.reason === 'aborted') return
    if (failure.reason === 'everything-not-running') {
      this.ctx.logger?.warn?.(
        'dsh-at-file-everything: Everything is not running, so @path cannot list anything; start Everything and reopen the composer',
      )
      return
    }
    this.ctx.logger?.warn?.(`dsh-at-file-everything: ${failure.reason}: ${failure.detail}`)
  }

  /**
   * Contribute the prompt sections this plugin owns to one agent.
   *
   * Two sections, with deliberately different gates:
   *
   * - `context:file-reference` is the seam's stable `@path` guidance, offered
   *   only while the agent can call `read`, and only while `installPrompt` is on.
   * - `context:file-search` teaches the model when to use `find_files`. It is on
   *   whenever the tool is registered, with no configuration of its own: the whole
   *   point is that a user does not have to know the tool exists for the model to
   *   find it.
   *
   * Each text is resolved at assembly time rather than at install time, so a card
   * edit (or the tool appearing later) takes effect without reinstalling.
   *
   * @param agent - agent to install the prompt sections for.
   */
  private installPrompt(agent: Agent): void {
    if (this.prompts.has(agent)) return
    const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
      scope.systemPrompt.section({
        name: 'context:file-reference',
        order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
        text: () => (
          this.live('installPrompt') && scope.tools.get('read', agent) !== undefined
            ? FILE_REFERENCE_PROMPT
            : ''
        ),
      })
      scope.systemPrompt.section({
        name: 'context:file-search',
        // Placed immediately before the `glob` guidance, so the model reads
        // "where to look for a file" and "how to enumerate paths" as one decision.
        order: scope.systemPrompt.getSectionOrder('TOOL_GLOB') - 1,
        text: () => (this.searchPrompt ? FILE_SEARCH_PROMPT : ''),
      })
    })
    this.prompts.set(agent, fiber)
  }
}

/**
 * Install the Everything-backed file-reference provider and the `find_files` tool.
 *
 * Two capabilities from one index, for two different callers: the provider answers
 * a human typing `@` in the composer, and the tool answers the model, which
 * resolves paths itself. The tool is registered only where a `tools` service
 * exists, so a composition without one still gets `@` completion.
 *
 * @param ctx - host Cordis context.
 * @param config - validated configuration with schema defaults applied.
 */
export function apply(ctx: Context, config: ConfigShape = Config({})): void {
  const settings = normalizeConfig(config)
  const service = new EverythingFileReferenceService(ctx, settings)
  ctx.logger?.info?.('dsh-at-file-everything: answering @file from the Everything index')

  // Claim this instance's configuration page.
  //
  // Without this the Host keeps `autoGenerate: true` for our namespace and renders
  // a generic form built from the Config schema; the card the browser half
  // registers is then never shown, and because the schema holds only volatile
  // fields that generic form has nothing useful to draw. `configure` is the
  // documented way for a plugin to say "I own my page", and every first-party
  // plugin with a custom page calls exactly this line.
  ctx.inject?.(['settings'], (scope) => {
    scope.effect(
      () => scope.settings?.configure({ auto: false }, ctx.fiber) ?? (() => {}),
      'dsh-at-file-everything: own the configuration page',
    )
  })

  // The card's status route.
  //
  // Gated on `inject`, not probed once: the Web server may be provided after this
  // plugin loads, and a one-shot `ctx.get` would then miss it forever, leaving the
  // card unable to say which es.exe is in effect.
  ctx.inject?.(['webServer'], (scope) => {
    installStatusRoute(scope, () => service.live('esCommand'), () => service.live('extraPathDirectories'))
  })

  // `tools` is optional: a library or headless composition may register none, and
  // the Web one provides it on its own schedule. `inject` retries when the service
  // appears, which is what makes the tool registration self-healing rather than a
  // single attempt at load time.
  ctx.inject?.(['tools'], (scope) => {
    // Reading the configuration through the service keeps one source of truth, so
    // a card edit reaches the tool as well as `@`.
    const tool = buildFindFilesTool(
      makeFindFilesHost({
        esCommand: () => service.live('esCommand'),
        extraPathDirectories: () => service.live('extraPathDirectories'),
        timeoutMs: () => service.live('timeoutMs'),
        deadlineMs: () => service.live('deadlineMs'),
        exclusions: () => [
          ...folderExclusionTerms(service.live('excludeInQuery')),
          ...fileExclusionTerms(service.live('excludeFilePatterns')),
        ],
      }),
    )
    scope.tools?.register(tool)
    // Only now is the guidance true: telling the model to call a tool that was
    // never registered would make it try and fail on every file search.
    service.searchPrompt = true
  })
}

/**
 * Register the card's `es.exe` status route on an already-gated Web server scope.
 *
 * The handler always answers JSON, including when resolution fails, so the card can
 * tell "the Host could not look" from "nothing was found" — they need different
 * messages and only one of them means the user has to install anything.
 *
 * @param scope - a scope that requires `webServer`.
 * @param esCommand - reads the configured command.
 * @param extraPathDirectories - reads the extra directories searched before `PATH`.
 */
function installStatusRoute(
  scope: Context,
  esCommand: () => string,
  extraPathDirectories: () => string[],
): void {
  const web = scope.webServer
  if (!isWebServer(web)) return
  scope.effect(
    () =>
      web.register({
        kind: 'exact',
        path: STATUS_ROUTE,
        // Async on purpose: the answer includes the client's own version, which
        // needs one short child process. `-version` does not need the Everything
        // service, so this still answers while the index is unavailable.
        handler: async (_req: unknown, res: {
          writeHead(status: number, headers: Record<string, string>): void
          end(body: string): void
        }) => {
          try {
            const status = esStatus(esCommand(), extraPathDirectories())
            const version = status.effective === undefined ? undefined : await esVersion(status.effective)
            const body = statusBody(version === undefined ? status : { ...status, version })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(body)
          } catch (error) {
            // A failed resolution is still an answer the card must render.
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      }),
    'dsh-at-file-everything: es.exe status route',
  )
}

/**
 * Narrow a probed service to the one route-registering method used here.
 * @param value - whatever `ctx.get('webServer')` answered.
 * @returns whether it can accept a route.
 */
function isWebServer(value: unknown): value is {
  register(route: { kind: 'exact'; path: string; handler: (req: unknown, res: never) => void }): unknown
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { register?: unknown }).register === 'function'
  )
}

/**
 * Normalize a working directory to an absolute Windows path without a trailing
 * separator, which is what path joins and relative comparison assume.
 * @param cwd - working directory as the harness reports it.
 * @returns the normalized root.
 */
export function normalizeRoot(cwd: string): string {
  const withoutSlash = cwd.replaceAll('/', '\\').replace(/\\+$/, '')
  return withoutSlash === '' ? cwd : withoutSlash
}

/**
 * Render an unknown thrown value for a log line.
 * @param error - thrown value.
 * @returns a non-empty description.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
