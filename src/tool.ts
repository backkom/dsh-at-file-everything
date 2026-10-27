/**
 * The `find_files` model tool: Everything's index, as a tool the agent can call.
 *
 * ## Why a tool as well as the `@` provider
 *
 * The `@` provider answers a *human* typing in the composer. It cannot help the
 * agent, which resolves paths itself: without this tool the model's only options
 * are `glob`, which walks the tree, and shell commands, which walk it worse. On
 * the workspace this plugin was written for — ~1.5 M files, ~1.2 M of them under
 * `Library/` and `Output/` — neither reaches the sources before its budget runs
 * out. Everything already holds that index, so the same lookup that makes `@`
 * fast makes the tool fast.
 *
 * ## Why it is not a wrapper over the provider
 *
 * The provider is deliberately *narrow*: it is scoped to one working directory,
 * ranks for human keystrokes, and answers paths relative to that root. A model
 * asking "where is this file" wants the opposite on all three counts — it may
 * search any indexed drive, it wants every match rather than the twenty most
 * typeable, and it needs absolute paths it can hand to `read`. Sharing the
 * low-level `EsClient` while keeping the selection logic apart is what lets each
 * answer its own caller instead of compromising on one.
 *
 * ## Safety of scope
 *
 * This tool searches the whole index, on purpose. The provider's `-path`
 * confinement exists because a completion box must never surface a file from a
 * sibling checkout the user cannot see; a model asked to find a file has the
 * opposite need, and confining it would make the tool useless on multi-repo
 * machines. It returns absolute paths, and the model decides what to read.
 *
 * @module dsh-at-file-everything/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { EsClient, contiguousTerm, type EsFailure, type EsRow } from './es-client.js'
import { resolveEsCommands } from './resolve.js'

/** Tool name, as the model sees it. */
export const TOOL_NAME = 'find_files'

/**
 * System-prompt guidance that teaches the model when to reach for the tool.
 *
 * A tool description alone is not enough. The model sees `glob`, `grep` and
 * `find_files` side by side and picks by habit, which in practice means `glob` —
 * the one that walks the tree and gives up. This section is the missing sentence:
 * *which* of the three to use for *which* question. It is installed
 * unconditionally whenever the tool registers, because a user should never have
 * to know that a prompt needs configuring for the tool to be found at all.
 */
export const FILE_SEARCH_PROMPT = `The \`find_files\` tool answers "where is this file" from Everything's machine-wide index, which is already built and updated live. It returns absolute paths.

Prefer \`find_files\` over \`glob\` when locating a file by name:
- the file may live outside the workspace, or in a folder the workspace rules ignore (\`Library/\`, \`Output/\`, \`node_modules/\`, hidden folders);
- the tree is large enough that a walk is slow or gives up before reaching the file;
- you know part of the name but not the directory.

Prefer \`glob\` for a path *pattern* inside the workspace that must respect ignore rules, and \`grep\` for file *contents*. \`find_files\` searches names only — never contents.

Pass \`path\` to confine the search to a folder and its subfolders; omit it to search every indexed drive. Results are paged: when the answer says more matched, raise \`limit\` or narrow \`query\`/\`path\` rather than assuming the list is complete.`

/** Most matches one call may return. Past this the page buries the caller. */
export const MAX_LIMIT = 500

/** Default page size when the caller names none. */
export const DEFAULT_LIMIT = 50

/** One row of the tool's result. */
export interface FoundEntry {
  /** Absolute path, in host form. */
  path: string
  /** Final path segment. */
  name: string
  /** Whether the entry is a folder. */
  directory: boolean
}

/** The tool's structured value. */
export interface FindFilesResult {
  /** The entries on this page. */
  results: FoundEntry[]
  /** How many entries this page holds. */
  count: number
  /** Whether more entries matched than this page returned. */
  truncated: boolean
  /** The folder the search was confined to, when one was requested. */
  scope?: string
}

/**
 * Build the Everything term for a tool query.
 *
 * The model writes a plain file name or fragment, not Everything syntax: this
 * tool is for "find this file", and exposing the query dialect would invite
 * `ext:`/`dm:` expressions whose interactions with `-path` and the exclusions are
 * a whole other surface. The term is therefore a literal substring of the name.
 *
 * A query of `*` or empty means "everything in scope", which is what a listing
 * of a folder asks for.
 *
 * @param query - the caller's text.
 * @returns an `es.exe` term.
 */
export function toolTerm(query: string): string {
  const trimmed = query.trim()
  if (trimmed === '' || trimmed === '*') return '**'
  return contiguousTerm(trimmed)
}

/**
 * Clamp a requested page size into the tool's bounds.
 * @param value - the caller's `limit`, or undefined.
 * @returns a positive integer no larger than {@link MAX_LIMIT}.
 */
export function clampLimit(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(numeric), MAX_LIMIT)
}

/**
 * Render the result for the model.
 *
 * One absolute path per line, and a closing line that says how the page relates
 * to the match set — a model that cannot tell "these are all of them" from "these
 * are the first fifty" will confidently report a missing file.
 *
 * @param value - the tool's structured value.
 * @returns the text block handed to the model.
 */
export function renderFindFiles(value: FindFilesResult): string {
  if (value.results.length === 0) {
    return value.scope === undefined
      ? 'No matches.'
      : `No matches under ${value.scope}.`
  }
  const lines = value.results.map((entry) => {
    // Everything already reports a folder with a trailing separator; adding
    // another would render `\dir\\`. One trailing mark is what distinguishes a
    // folder from a file of the same name, so it is kept either way.
    if (!entry.directory) return entry.path
    return entry.path.endsWith('\\') ? entry.path : `${entry.path}\\`
  })
  const head = `${String(value.count)} match(es)${value.scope === undefined ? '' : ` under ${value.scope}`}:`
  const tail = value.truncated
    ? `\n(more than ${String(value.count)} matched; raise \`limit\`, or narrow \`query\`/\`path\`)`
    : ''
  return `${head}\n${lines.join('\n')}${tail}`
}

/**
 * Turn queried rows into the tool's entries, dropping anything outside `scope`.
 *
 * The scope re-check is not redundant with `-path`: `-path` is a query hint, and
 * a row whose path merely contains the scope string would otherwise ride along.
 *
 * @param rows - rows reported by Everything.
 * @param scope - the normalised folder the query was confined to, if any.
 * @returns entries, in the order Everything returned them.
 */
export function toEntries(rows: readonly EsRow[], scope: string | undefined): FoundEntry[] {
  const entries: FoundEntry[] = []
  // Normalise here rather than trusting the caller: `-path` accepts either
  // separator and Everything answers in backslashes, so a forward-slash scope
  // would fail every comparison and drop the whole page.
  const root = scope === undefined ? undefined : scope.replaceAll('/', '\\').replace(/\\+$/, '')
  const prefix = root === undefined ? undefined : `${root}\\`.toLowerCase()

  for (const row of rows) {
    const absolute = row.path.replaceAll('/', '\\')
    if (root !== undefined && prefix !== undefined) {
      const lowered = absolute.toLowerCase()
      const inside = lowered === root.toLowerCase() || lowered.startsWith(prefix)
      if (!inside) continue
    }
    const trimmed = absolute.replace(/\\+$/, '')
    const index = trimmed.lastIndexOf('\\')
    if (index < 0) continue
    const name = trimmed.slice(index + 1)
    if (name === '') continue
    entries.push({ path: absolute, name, directory: row.directory })
  }
  return entries
}

/** What the tool needs from the plugin that owns it. */
export interface FindFilesHost {
  /**
   * Build a client for the current configuration.
   *
   * Both exclusion lists are applied here as well as in the `@` provider: a
   * model searching for a source file should not have to wade through the same
   * generated trees a human's completion hides.
   */
  client(): { client: EsClient; exclusions: string[] }
}

/**
 * Build the tool definition.
 *
 * Kept as a factory over a host accessor rather than closing over the service,
 * so the definition can be exercised in the test suite without a Harness
 * installation: the host supplies the client, the tool owns the contract.
 *
 * @param host - the owning plugin's client and exclusion settings.
 * @returns a registry-ready tool definition.
 */
export function buildFindFilesTool(host: FindFilesHost) {
  return defineTool({
    name: TOOL_NAME,
    description:
      'Find files and folders anywhere on this machine by name, through the local Everything index. '
      + 'Faster and far wider than scanning a directory tree, and it reaches folders that a workspace walk '
      + 'skips. Search by name or name fragment only — it cannot search file contents, so use grep for that. '
      + '`path` confines the search to one folder and its subfolders. Use `limit` to page; the result says '
      + 'whether more matched.',
    parameters: {
      query: {
        type: 'string',
        description:
          'File or folder name, or any contiguous fragment of one. Case-insensitive. Use `*` or omit it to list a folder.',
      },
      path: {
        type: 'string',
        description:
          'Absolute folder to confine the search to, including all its subfolders. Omit to search every indexed drive.',
      },
      foldersOnly: {
        type: 'boolean',
        description: 'Return only folders.',
      },
      filesOnly: {
        type: 'boolean',
        description: 'Return only files.',
      },
      limit: {
        type: 'integer',
        description: `Maximum entries to return (default ${String(DEFAULT_LIMIT)}, at most ${String(MAX_LIMIT)}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                name: { type: 'string', required: true },
                directory: { type: 'boolean', required: true },
              },
            },
          },
          count: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          scope: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderFindFiles(value as FindFilesResult) }],
      // The Web search card cannot be rebuilt from the rendered text, so the page
      // is projected into the metadata the presenter narrows back.
      presentationMeta: (_args, value) => {
        const page = value as FindFilesResult
        return {
          shape: 'paths',
          paths: page.results.map((entry) => entry.path),
          truncated: page.truncated,
          total: page.count,
        }
      },
    },
    async execute(args, exec) {
      const { client, exclusions } = host.client()
      const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
      const scope = requestedPath === ''
        ? undefined
        : requestedPath.replaceAll('/', '\\').replace(/\\+$/, '')
      const queryText = typeof args.query === 'string' ? args.query.trim() : ''

      if (scope === undefined && queryText === '') {
        // Without either, Everything answers the head of the whole index, which
        // is never what the caller meant and costs a full page of context.
        throw new Error(
          'find_files needs something to find: pass `query` (a file or folder name), or `path` alone to list a folder.',
        )
      }

      const limit = clampLimit(args.limit)
      const terms: string[] = []
      if (scope !== undefined) terms.push('-path', scope)
      terms.push('-n', String(limit))
      if (args.foldersOnly === true) terms.push('/ad')
      if (args.filesOnly === true) terms.push('/a-d')

      const rows = await client.query([...terms, ...exclusions, toolTerm(queryText)], exec.signal)
      if (!Array.isArray(rows)) {
        throw failureToError(rows)
      }

      const entries = toEntries(rows, scope).slice(0, limit)
      const result: FindFilesResult = {
        results: entries,
        count: entries.length,
        truncated: rows.length >= limit,
        ...(scope === undefined ? {} : { scope }),
      }
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `find_files: ${args.query ?? args.path ?? ''}`,
      kind: 'search',
      rawInput: args,
    }),
    // Narrow the projected page back into the Web search card. Malformed or
    // absent metadata (an older log, a nested call) returns undefined so the card
    // falls back to the rendered text instead of throwing during replay; a
    // zero-match page is a legitimate empty card.
    presentResult: (_args, result) => {
      const meta = result?.meta
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
      const { paths, truncated, total } = meta as { paths?: unknown; truncated?: unknown; total?: unknown }
      if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === 'string')) return undefined
      if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
      return {
        card: 'search',
        shape: 'paths',
        title: `find_files: ${String(paths.length)} path(s)`,
        paths,
        truncated,
        total,
      }
    },
  })
}

/**
 * Turn a typed backend failure into the error the model should read.
 *
 * The message names the cause and the alternative, because a model that only
 * learns "it failed" retries the same call; one that learns *why* switches to
 * `glob`.
 *
 * @param failure - the failure reported by the client.
 * @returns an error carrying an actionable message.
 */
export function failureToError(failure: EsFailure): Error {
  if (failure.reason === 'everything-not-running') {
    return new Error(
      'find_files cannot run: Everything is not running, so its index cannot be queried. '
      + 'Ask the user to start Everything, and use the built-in glob tool meanwhile.',
    )
  }
  if (failure.reason === 'aborted') return new Error('find_files was cancelled.')
  return new Error(
    `find_files failed (${failure.reason}): ${failure.detail}. `
    + 'If this persists, use the built-in glob tool to search by path instead.',
  )
}

/**
 * Build the host accessor a plugin uses to expose the tool.
 *
 * @param settings - reads the current configuration.
 * @returns a host whose `client()` follows the live settings.
 */
export function makeFindFilesHost(settings: {
  esCommand(): string
  extraPathDirectories(): string[]
  timeoutMs(): number
  deadlineMs(): number
  exclusions(): string[]
}): FindFilesHost {
  return {
    client() {
      const candidates = resolveEsCommands(settings.esCommand(), settings.extraPathDirectories())
      return {
        client: new EsClient(candidates.map((candidate) => candidate.path), {
          timeoutMs: settings.timeoutMs(),
          deadlineMs: settings.deadlineMs(),
        }),
        exclusions: settings.exclusions(),
      }
    },
  }
}
