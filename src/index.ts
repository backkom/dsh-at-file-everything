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

import { EsClient, contiguousTerm, subsequenceTerm, type EsFailure, type EsRow } from './es-client.js'
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
export { contiguousTerm, parseCsv, subsequenceTerm } from './es-client.js'

export type { Candidate, RawCandidate } from './candidates.js'
export type { EsFailure, EsRow } from './es-client.js'

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
 * Directory basenames dropped from candidates.
 *
 * These are the shipped provider's defaults plus the trees that motivated this
 * plugin. `lib` stays out on purpose, exactly as upstream: many ecosystems keep
 * real sources there.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.git',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
]

/** Plugin configuration, validated by the Loader at load time. */
export interface Config {
  /**
   * Path or bare name of the Everything command-line client. A bare name such
   * as `es.exe` is resolved through `PATH` by Windows.
   */
  esCommand: string
  /** Maximum ranked candidates returned for one query. */
  maxResults: number
  /** Rows requested from Everything before ranking. */
  maxCandidates: number
  /** Deadline for one `es.exe` invocation in milliseconds. */
  timeoutMs: number
  /** Directory basenames dropped from candidates. */
  excludedDirectories: string[]
  /**
   * Allow a fuzzy subsequence search when a query has no contiguous match.
   *
   * Everything answers the wildcard subsequence form from its index in
   * ~90–150 ms, so this is on by default; it stays a switch because a
   * deployment that prefers never widening a query can turn it off.
   */
  fuzzyFallback: boolean
  /**
   * Directories prepended to the child `PATH` when `esCommand` is a bare name.
   * The default installer location is searched automatically when it is on
   * `PATH`; this covers portable and per-user installations elsewhere.
   */
  extraPathDirectories: string[]
  /**
   * Install the model-facing `@path` guidance section.
   *
   * The section is the seam's stable `FILE_REFERENCE_PROMPT`; it is installed
   * only when the addressed agent can actually call `read`, matching the
   * shipped provider, so a session without filesystem tools is not told about
   * paths it cannot open.
   */
  installPrompt: boolean
}

/** Configuration schema with defaults; the Loader applies it at load time. */
export const Config: Schema<Config> = z.object({
  esCommand: z.string().default('es.exe'),
  maxResults: z.number().step(1).min(1).default(20),
  maxCandidates: z.number().step(1).min(1).default(300),
  timeoutMs: z.number().step(1).min(1).default(3000),
  excludedDirectories: z.array(z.string()).default([...DEFAULT_EXCLUDED_DIRECTORIES]),
  fuzzyFallback: z.boolean().default(true),
  extraPathDirectories: z.array(z.string()).default([]),
  installPrompt: z.boolean().default(true),
}) as Schema<Config>

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
  private readonly settings: Config
  private readonly excluded: Set<string>
  private readonly states = new WeakMap<Agent, AgentState>()
  private readonly prompts = new Map<Agent, { dispose(): Promise<void> }>()

  /**
   * @param ctx - host Cordis context.
   * @param config - validated configuration with schema defaults applied.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.settings = config
    this.excluded = new Set(config.excludedDirectories.map((entry) => entry.toLowerCase()))

    if (config.installPrompt) {
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
    }

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
    const state: AgentState = {
      cwd,
      client: new EsClient(this.settings.esCommand, this.settings.timeoutMs, this.settings.extraPathDirectories),
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
    const segments = directory.split('/').filter(Boolean)
    if (segments.some((segment) => this.excluded.has(segment.toLowerCase()))) return []

    // Refuse a path that leaves the workspace. `@../other/` would otherwise be
    // joined onto the root and handed to Everything, turning completion into a
    // reader for any indexed directory on the machine — the same failure mode
    // as an unscoped query, just spelled as a relative path.
    const absolute = toWindowsPath(state.cwd, segments)
    if (!isWithin(state.cwd, absolute)) return []

    const found = await state.client.query(
      ['-parent', absolute, '-n', String(this.settings.maxCandidates)],
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
      if (row.directory && this.excluded.has(entryName.toLowerCase())) continue
      rows.push({
        path: `${directory}${entryName}`,
        name: entryName,
        kind: row.directory ? 'directory' : 'file',
      })
    }
    return rank(rows, directory + fragment, this.settings.maxResults)
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
    const scope = ['-path', state.cwd, '-n', String(this.settings.maxCandidates)]

    const found = await state.client.query([...scope, contiguousTerm(query)], signal)
    if (!Array.isArray(found)) {
      this.report(found)
      return []
    }
    let rows = this.toRawCandidates(state.cwd, found, query)

    if (found.length === 0 && this.settings.fuzzyFallback && !signal.aborted) {
      const fuzzy = await state.client.query([...scope, subsequenceTerm(query)], signal)
      if (!Array.isArray(fuzzy)) {
        this.report(fuzzy)
        return []
      }
      rows = this.toRawCandidates(state.cwd, fuzzy, query)
    }

    return rank(filterExcluded(rows, this.excluded), query, this.settings.maxResults)
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

  /** Log a search-backend failure that degraded to an empty answer. */
  private report(failure: EsFailure): void {
    if (failure.reason === 'aborted') return
    this.ctx.logger?.warn?.(`dsh-at-file-everything: ${failure.reason}: ${failure.detail}`)
  }

  /**
   * Contribute the seam's `@path` guidance to one agent while it can call
   * `read`, mirroring the shipped provider's behaviour.
   * @param agent - agent to install the prompt section for.
   */
  private installPrompt(agent: Agent): void {
    if (this.prompts.has(agent)) return
    const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
      scope.systemPrompt.section({
        name: 'context:file-reference',
        order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
        text: () => (scope.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT),
      })
    })
    this.prompts.set(agent, fiber)
  }
}

/**
 * Install the Everything-backed file-reference provider.
 *
 * @param ctx - host Cordis context.
 * @param config - validated configuration with schema defaults applied.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  new EverythingFileReferenceService(ctx, normalizeConfig(config))
  ctx.logger?.info?.('dsh-at-file-everything: answering @file from the Everything index')
}

/**
 * Validate configuration the Loader may have handed through unvalidated.
 * @param config - raw configuration.
 * @returns a complete, validated configuration.
 */
export function normalizeConfig(config: Config): Config {
  const maxResults = config.maxResults ?? 20
  const maxCandidates = config.maxCandidates ?? 300
  const timeoutMs = config.timeoutMs ?? 3000
  if (!Number.isSafeInteger(maxResults) || maxResults <= 0) {
    throw new Error('dsh-at-file-everything: maxResults must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
    throw new Error('dsh-at-file-everything: maxCandidates must be a positive safe integer')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('dsh-at-file-everything: timeoutMs must be a positive safe integer')
  }
  const excludedDirectories = config.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES
  if (excludedDirectories.some((entry) => entry === '' || entry.includes('/') || entry.includes('\\'))) {
    throw new Error('dsh-at-file-everything: excludedDirectories entries must be non-empty directory basenames')
  }
  const esCommand = config.esCommand ?? 'es.exe'
  if (esCommand.trim() === '') throw new Error('dsh-at-file-everything: esCommand must not be empty')
  return {
    esCommand,
    maxResults,
    maxCandidates,
    timeoutMs,
    excludedDirectories: [...excludedDirectories],
    fuzzyFallback: config.fuzzyFallback ?? true,
    extraPathDirectories: [...(config.extraPathDirectories ?? [])],
    installPrompt: config.installPrompt ?? true,
  }
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
