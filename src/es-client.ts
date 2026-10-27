/**
 * Process-level wrapper around the Everything command-line client (`es.exe`)
 * plus the search syntax this plugin emits.
 *
 * Four behaviours, each established by probing the real client, shape this
 * module:
 *
 * 1. **One argv element per term.** Every non-switch argument is an independent
 *    AND-ed search term. A single argument holding spaces (`"package json"`)
 *    matches nothing, while `package` and `json` as separate arguments match
 *    `package.json`. Terms must therefore never be space-joined.
 *
 * 2. **Everything indexes filenames; `-p` widens the term to the full path.**
 *    Without `-p` a term matches the file name only, which is also the fast
 *    path: the wildcard subsequence form runs in ~90–150 ms on a 470k-entry
 *    Unity workspace with the name index, versus 0.6–44 s when a `regex:`
 *    term forces a full path scan. Queries stay filename-scoped for that
 *    reason, and `-path` supplies the scoping instead.
 *
 * 3. **Standard output is not UTF-8.** `es.exe` writes results in the process
 *    ANSI/OEM code page, so CJK and kana names arrive as mojibake on a zh-CN
 *    host. The only code-page-independent channel is `-export-csv <file>` with
 *    `-utf8-bom`, which writes real UTF-8 to a file this module owns. Export
 *    costs about as much as stdout (measured ~110 ms against ~100 ms), so every
 *    query takes it.
 *
 * 4. **The client version decides what a switch costs.** `-n <max>` is not a
 *    pure page limit in every release: from 1.1.0.35 on it is applied as a
 *    `count:` filter, which against Everything 1.4 costs ~300 ms per query
 *    before returning a single row (measured: 52 ms at 1.1.0.26 → 285 ms at
 *    1.1.0.38 → 275 ms at 1.1.1.39 for the same 20-row page). The pinned
 *    bundled copy is therefore the last release that keeps `-n` cheap while
 *    still supporting `--` and `-get-result-count`; see `bin/README.md`.
 *
 * @module dsh-at-file-everything/es-client
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Result of one `es.exe` run that produced output. */
export interface EsResult {
  /** Exit code; `0` for a successful run, including one with no results. */
  code: number
  /** UTF-8 decoded standard output. */
  text: string
  /** Standard error, decoded as UTF-8 (diagnostics are ASCII). */
  stderr: string
}

/** Construction options for {@link EsClient}. */
export interface EsClientOptions {
  /** Database-load timeout passed to `es.exe -timeout`, in milliseconds. */
  timeoutMs: number
  /** Deadline after which a running child is killed, in milliseconds. */
  deadlineMs: number
  /** Directories prepended to the child `PATH`. */
  extraPathDirectories?: readonly string[]
}

/** One row of an `-export-csv` run with `Attributes` and `Filename` columns. */
export interface EsRow {
  /** Absolute Windows path, decoded from UTF-8. */
  path: string
  /** Whether Everything reported the entry as a directory. */
  directory: boolean
}

/** Typed description of a query that produced no rows for a reason. */
export interface EsFailure {
  /** Stable machine-readable cause. */
  reason:
    | 'spawn-failed'
    | 'timeout'
    | 'aborted'
    | 'exit-code'
    | 'unreadable-output'
    | 'everything-not-running'
  /** Human-readable detail for logs. */
  detail: string
}

/**
 * `es.exe` reports "no results" as exit code 9 unless `-no-result-error` is
 * passed. `run()` always passes it, so 9 is treated as an empty result for
 * robustness rather than as an error.
 */
const EXIT_NO_RESULTS = 9

/**
 * `es.exe` reports "no Everything IPC window" as exit code 8, which means the
 * Everything client is not running at all.
 *
 * This is worth separating from every other failure: it is the one cause the
 * user can fix in a second by launching Everything, and the one where an empty
 * answer is most misleading — the index exists and is complete, nothing is
 * answering it. `@` would otherwise appear to know nothing.
 */
const EXIT_NO_SERVICE = 8

/**
 * Escape the characters Everything's `regex:` dialect treats specially.
 * @param text - literal text.
 * @returns the escaped fragment.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Escape one literal fragment for an `es.exe` search term.
 *
 * `es.exe` treats space as a term separator, and Everything's own boolean
 * operators (`&`, `|`, `<`, `>`) as syntax, so a literal fragment must have both
 * neutralised. A space inside a wildcard pattern is represented by `?`, which
 * matches exactly one character — the fragment is fixed-length, so `?` is an
 * exact substitute rather than a widening.
 *
 * @param text - literal text typed by the user.
 * @returns the escaped fragment, free of term separators.
 */
export function escapeTerm(text: string): string {
  return text
    .replaceAll(' ', '?')
    .replace(/([\\&|<>^"])/g, (character) => `^${character}`)
}

/**
 * Build the term that matches `query` as a case-insensitive contiguous
 * substring of an indexed **file name**.
 *
 * This is the first tier: contiguous substring is the overwhelmingly common
 * intent and costs ~70 ms on a large workspace.
 *
 * @param query - text typed after `@`.
 * @returns an `es.exe` search term containing no spaces.
 */
export function contiguousTerm(query: string): string {
  return `*${escapeTerm(query)}*`
}

/**
 * Build the terms that prune a folder subtree from a query.
 *
 * Everything prunes while it walks the index, so an excluded tree costs nothing at
 * query time — unlike filtering the returned rows, which spends the candidate
 * budget on rows that are thrown away afterwards.
 *
 * ## Why `path:*\<pattern>\*`
 *
 * The spellings that look right are not:
 *
 * | Term | What it actually does |
 * |---|---|
 * | `!path:Library` | Matches the *string* anywhere in the path, so `Library.txt` and `LibraryBeta` go too. |
 * | `!folder:Library` | Matches the folder row but not its contents, so the subtree stays. |
 * | `!\Library\` | Prunes the exact folder and its contents — but a pattern cannot go there: `!\Lib*\` matches nothing. |
 * | `!path:*\Lib*\*` | Prunes any folder whose name matches the pattern, contents included. |
 *
 * The last form is the one this module emits, and it is why the UI can accept a
 * plain `Lib*` without asking the user to know any of this: the leading `*` makes
 * the segment match at any depth, and the trailing `\*` is what actually reaches
 * the contents. `?\`-style patterns and case variants behave inconsistently in the
 * segment, so the card's help text points at `*` rather than promising more.
 *
 * @param patterns - folder-name patterns (`Library`, `Lib*`) to prune.
 * @returns one `es.exe` term per pattern.
 */
export function folderExclusionTerms(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => `!path:*\\${escapeTerm(pattern)}\\*`)
}

/**
 * Build the terms that exclude file names from a query.
 *
 * The file counterpart of {@link folderExclusionTerms}, and it parses differently:
 * Everything treats a bare `!*.meta` as an exclusion pattern over the name, so a
 * leading `!` is enough — wrapping it in separators would make it a path test and
 * match nothing.
 *
 * @param patterns - file-name patterns (`*.meta`) to prune.
 * @returns one `es.exe` term per pattern.
 */
export function fileExclusionTerms(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => `!${pattern}`)
}

/**
 * Build the term for a directory listing, optionally narrowed by a fragment.
 *
 * `**` is Everything's "match every name", so a blank fragment asks for the
 * directory's whole contents while a non-blank one is answered by the index
 * rather than by the caller. That distinction is what keeps a listing correct:
 * `-n` truncates the *rows returned*, so filtering a truncated page in the
 * caller silently loses entries whenever a directory holds more children than
 * the page size, and the lost entries are the ones whose names sort last.
 *
 * @param fragment - text typed after the final `/`, possibly empty.
 * @returns an `es.exe` search term containing no spaces.
 */
export function listingTerm(fragment: string): string {
  return fragment === '' ? '**' : contiguousTerm(fragment)
}

/**
 * Build the term that matches `query` as a case-insensitive **subsequence** of
 * an indexed file name: every character in order, gaps allowed.
 *
 * `filedock` therefore matches `FileDock`-style names where a contiguous
 * search would miss the camel-case gap. Everything answers this from the index
 * rather than a scan, so it is the affordable fuzzy tier.
 *
 * @param query - text typed after `@`.
 * @returns an `es.exe` search term containing no spaces.
 */
export function subsequenceTerm(query: string): string {
  const characters = [...query]
  if (characters.length === 0) return '*'
  return `*${characters.map((character) => escapeTerm(character)).join('*')}*`
}

/**
 * One cancellable `es.exe` runner.
 *
 * The child starts with `windowsHide` so a keystroke never flashes a console
 * window, and is killed when the caller aborts or the deadline expires.
 *
 * Two timeouts are kept apart on purpose. `timeoutMs` is handed to `es.exe` as
 * `-timeout`, which is *its* wait for the Everything database to finish loading;
 * `deadlineMs` is when this process kills the child. Collapsing them means the
 * process deadline has to cover a cold-index load, so a healthy but slow query is
 * killed at the same moment `es.exe` gives up — and the failure looks like a
 * timeout rather than "the index was still loading".
 */
export class EsClient {
  /** Executable paths to try, in order; a broken first candidate falls through. */
  readonly candidates: readonly string[]
  /** Database-load timeout passed to `es.exe -timeout`, in milliseconds. */
  readonly timeoutMs: number
  /** Deadline after which a running child is killed, in milliseconds. */
  readonly deadlineMs: number
  /** Directories prepended to the child `PATH`. */
  readonly extraPathDirectories: string[]

  /**
   * @param candidates - executable paths to try, in order; the last always exists.
   * @param options - timeouts and path additions.
   */
  constructor(candidates: readonly string[], options: EsClientOptions) {
    this.candidates = [...candidates]
    this.timeoutMs = options.timeoutMs
    this.deadlineMs = options.deadlineMs
    this.extraPathDirectories = [...(options.extraPathDirectories ?? [])]
  }

  /** The child environment, with the extra directories ahead of the inherited `PATH`. */
  private environment(): NodeJS.ProcessEnv {
    if (this.extraPathDirectories.length === 0) return process.env
    const current = process.env.PATH ?? ''
    return {
      ...process.env,
      PATH: [...this.extraPathDirectories, current].filter(Boolean).join(delimiter),
    }
  }

  /**
   * Run `es.exe` once and return its captured output.
   *
   * @param executable - the resolved path to execute.
   * @param args - argument vector; `-no-result-error` is appended automatically.
   * @param signal - caller cancellation.
   * @returns the captured run, or a typed failure.
   */
  private async run(
    executable: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<EsResult | EsFailure> {
    if (signal.aborted) return { reason: 'aborted', detail: 'query cancelled before start' }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, [...args, '-no-result-error'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.environment(),
      })
    } catch (error) {
      return { reason: 'spawn-failed', detail: error instanceof Error ? error.message : String(error) }
    }

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    let timedOut = false
    let spawnError: Error | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, this.deadlineMs)
    const onAbort = (): void => {
      child.kill()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (error: Error) => {
        spawnError = error
        resolve(null)
      })
      child.on('close', (value: number | null) => {
        resolve(value)
      })
    }).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    })

    const diagnostics = Buffer.concat(stderr).toString('utf8').trim()
    if (spawnError !== undefined) {
      return { reason: 'spawn-failed', detail: spawnError.message }
    }
    if (signal.aborted) return { reason: 'aborted', detail: diagnostics || 'query cancelled' }
    if (timedOut) return { reason: 'timeout', detail: `es.exe exceeded ${String(this.deadlineMs)} ms` }
    if (code === EXIT_NO_RESULTS) return { code: 0, text: '', stderr: diagnostics }
    if (code === EXIT_NO_SERVICE) {
      return {
        reason: 'everything-not-running',
        detail: 'Everything is not running, so its index cannot be queried',
      }
    }
    if (code !== 0) {
      return {
        reason: 'exit-code',
        detail: diagnostics === '' ? `es.exe exited with code ${String(code)}` : diagnostics,
      }
    }
    return { code: 0, text: Buffer.concat(stdout).toString('utf8'), stderr: diagnostics }
  }

  /**
   * Query paths and read them back as UTF-8 rows.
   *
   * Candidates are tried in order and a candidate that cannot be spawned falls
   * through to the next one. That is what makes the resolution order forgiving: a
   * configured path that has since been uninstalled costs one failed `spawn`, not
   * a dead completion list, and the bundled copy answers instead.
   *
   * The `Attributes` column distinguishes a directory from a file without a
   * second filesystem round trip: an `Attributes` cell containing `D` is a
   * directory.
   *
   * @param args - argument vector, without the export switches.
   * @param signal - caller cancellation.
   * @returns parsed rows (possibly empty), or a typed failure.
   */
  async query(args: string[], signal: AbortSignal): Promise<EsRow[] | EsFailure> {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-at-file-everything-'))
    const file = join(directory, 'results.csv')
    try {
      let result: EsResult | EsFailure = {
        reason: 'spawn-failed',
        detail: 'no es.exe candidate to run',
      }
      for (const executable of this.candidates) {
        result = await this.run(
          executable,
          ['-timeout', String(this.timeoutMs), '-csv', '-attributes', '-utf8-bom', '-export-csv', file, ...args],
          signal,
        )
        // Only a spawn failure means "this candidate is not usable"; every other
        // outcome is an answer about the query, not about the executable.
        if (!('reason' in result) || result.reason !== 'spawn-failed') break
        if (signal.aborted) return { reason: 'aborted', detail: 'query cancelled' }
      }
      if (!('code' in result)) return result

      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        // A query with no results writes no file; that is an empty answer, not
        // a failure.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        return {
          reason: 'unreadable-output',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
      return parseCsv(text)
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
        /* A leftover temporary directory must not fail a keystroke. */
      })
    }
  }
}

/**
 * The `FILE_ATTRIBUTE_DIRECTORY` bit (0x10) as it appears in an export.
 *
 * `-attributes` does NOT write the `D` letter the documentation implies: it
 * writes the raw attribute value as a decimal number, so a directory is `16`
 * and an ordinary file `32`. A reader testing for the letter `D` therefore
 * classifies every row as a file — which is exactly what happened here before
 * this was measured against a real export.
 */
const ATTRIBUTE_DIRECTORY = 0x10

/**
 * Decide whether one `Attributes` cell describes a directory.
 *
 * Accepts both forms because they exist in the wild: the decimal bitmask this
 * client writes, and the `D`-letter form that some documentation and older
 * re-exports use.
 *
 * @param cell - the raw `Attributes` cell.
 * @returns whether the row is a directory.
 */
export function isDirectoryAttribute(cell: string): boolean {
  const trimmed = cell.trim()
  if (trimmed === '') return false
  // The letter form has no digits; the numeric form has nothing else.
  if (/^\d+$/.test(trimmed)) return (Number(trimmed) & ATTRIBUTE_DIRECTORY) !== 0
  return /[Dd]/.test(trimmed)
}

/**
 * Parse an `es.exe -csv -attributes` export.
 *
 * The first line is the header, preceded by the BOM `-utf8-bom` writes, and the
 * columns are located **by that header** rather than by position. That is not
 * defensive style: the order is not stable across releases. ES 1.1.0.34 writes
 * `Filename,Attributes`, while the argument order suggests the reverse, and a
 * positional reader silently swaps every path for an attribute string — the
 * query "works" and returns nonsense. Reading the header costs one comparison
 * per query and removes the whole class.
 *
 * Paths contain spaces, commas and quotes, so the filename column needs real CSV
 * unquoting rather than a split on commas.
 *
 * @param text - complete CSV content.
 * @returns parsed rows, skipping the header and any malformed line.
 */
export function parseCsv(text: string): EsRow[] {
  const rows: EsRow[] = []
  /** Column indexes learned from the header line, once it has been seen. */
  let nameColumn: number | undefined
  let attributeColumn: number | undefined

  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line === '') continue
    const parsed = parseCsvLine(line)
    if (parsed === undefined) continue

    if (nameColumn === undefined) {
      // The header names the columns; everything after it is data.
      const lowered = parsed.map((field) => field.trim().toLowerCase())
      nameColumn = lowered.indexOf('filename')
      attributeColumn = lowered.indexOf('attributes')
      if (nameColumn < 0) continue
      continue
    }

    const path = parsed[nameColumn]
    if (path === undefined || path === '') continue
    // A missing `-attributes` column means "no directory information", which is
    // exactly what a caller passing no attribute switch asked for.
    const attributes = attributeColumn === undefined || attributeColumn < 0 ? '' : (parsed[attributeColumn] ?? '')
    rows.push({ path, directory: isDirectoryAttribute(attributes) })
  }
  return rows
}

/**
 * Split one CSV line into fields, honouring `"` quoting and `""` escapes.
 * @param line - a single non-empty CSV line.
 * @returns the fields, or `undefined` when quoting is unbalanced.
 */
function parseCsvLine(line: string): string[] | undefined {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === ',') {
      fields.push(field)
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) return undefined
  fields.push(field)
  return fields
}
