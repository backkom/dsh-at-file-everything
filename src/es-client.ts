/**
 * Process-level wrapper around the Everything command-line client (`es.exe`,
 * v1.1.0.26) plus the search syntax this plugin emits.
 *
 * Three behaviours, each established by probing the real client, shape this
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
  reason: 'spawn-failed' | 'timeout' | 'aborted' | 'exit-code' | 'unreadable-output'
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
 */
export class EsClient {
  /** Executable name or absolute path. */
  readonly command: string
  /** Per-query deadline in milliseconds. */
  readonly timeoutMs: number
  /** Directories prepended to the child `PATH`. */
  readonly extraPathDirectories: string[]

  /**
   * @param command - executable name or absolute path.
   * @param timeoutMs - deadline after which the child is killed.
   * @param extraPathDirectories - directories prepended to the child `PATH`.
   */
  constructor(command: string, timeoutMs: number, extraPathDirectories: readonly string[] = []) {
    this.command = command
    this.timeoutMs = timeoutMs
    this.extraPathDirectories = [...extraPathDirectories]
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
   * Run `es.exe` and return its captured output.
   * @param args - argument vector; `-no-result-error` is appended automatically.
   * @param signal - caller cancellation.
   * @returns the captured run, or a typed failure.
   */
  async run(args: string[], signal: AbortSignal): Promise<EsResult | EsFailure> {
    if (signal.aborted) return { reason: 'aborted', detail: 'query cancelled before start' }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.command, [...args, '-no-result-error'], {
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
    }, this.timeoutMs)
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
    if (timedOut) return { reason: 'timeout', detail: `es.exe exceeded ${String(this.timeoutMs)} ms` }
    if (code === EXIT_NO_RESULTS) return { code: 0, text: '', stderr: diagnostics }
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
      const result = await this.run(
        ['-csv', '-attributes', '-utf8-bom', '-export-csv', file, ...args],
        signal,
      )
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
 * Parse an `es.exe -csv -attributes` export.
 *
 * The first line is the header, preceded by the BOM `-utf8-bom` writes. Paths
 * contain spaces, commas and quotes, so the filename column needs real CSV
 * unquoting rather than a split on commas.
 *
 * @param text - complete CSV content.
 * @returns parsed rows, skipping the header and any malformed line.
 */
export function parseCsv(text: string): EsRow[] {
  const rows: EsRow[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line === '') continue
    const parsed = parseCsvLine(line)
    if (parsed === undefined) continue
    const attributes = parsed[0]
    const path = parsed[1]
    if (attributes === undefined || path === undefined || path === '') continue
    if (attributes === 'Attributes') continue
    rows.push({ path, directory: attributes.includes('D') })
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
