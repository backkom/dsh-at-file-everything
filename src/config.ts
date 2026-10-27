/**
 * Configuration: its shape, its defaults, and the validation the Loader defers.
 *
 * Kept out of `index.ts` because none of it needs a Harness import. That is not
 * tidiness for its own sake: the validation path is the one that can leave the
 * entire bundle inactive (it did once), so it has to be testable in plain Node —
 * including the case that broke it, where every field arrives as a frozen `{ get }`
 * handle instead of a value.
 *
 * @module dsh-at-file-everything/config
 */

/**
 * Folder-name patterns filtered out of returned rows, when none is configured.
 *
 * Empty on purpose. What should be hidden is a property of the project, not of
 * the plugin: a Unity tree wants `Library` and `Output`, a Rust one `target`, a
 * monorepo neither, and a shipped default would silently hide real sources on the
 * first two and do nothing useful on the third. The card on the Plugins page is
 * where this is decided; leaving it empty means completion shows what the index
 * contains.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: string[] = []

/** Plugin configuration, validated by the Loader at load time. */
export interface Config {
  /**
   * Path or bare name of the Everything command-line client.
   *
   * A bare name (`es.exe`, the default) resolves through `extraPathDirectories`
   * and then `PATH`; the copy bundled with this package is used when neither
   * finds one. An absolute path is used as given.
   */
  esCommand: string
  /** Maximum ranked candidates returned for one query. */
  maxResults: number
  /** Rows requested from Everything before ranking. */
  maxCandidates: number
  /**
   * How long `es.exe` waits for the Everything database to load, in
   * milliseconds. This is passed as `-timeout`, which is the client's own wait,
   * not a deadline for this plugin.
   */
  timeoutMs: number
  /**
   * Deadline for one `es.exe` invocation in milliseconds, including process
   * start.
   *
   * Kept separate from `timeoutMs` on purpose: a cold index legitimately needs
   * seconds before the first query answers, and a single shared value would kill
   * a healthy query at the moment the client was still waiting for the database.
   */
  deadlineMs: number
  /**
   * Folder-name patterns filtered out of returned rows.
   *
   * A name or a pattern: `Library`, `Lib*`, `Temp?`. The `*` and `?` are honoured
   * by `matchesExcluded`; the user never writes Everything syntax.
   */
  excludedDirectories: string[]
  /**
   * Folder-name patterns pruned inside the Everything query itself.
   *
   * A name or a pattern (`Library`, `Lib*`), never Everything syntax — no leading
   * `!`, no separators. `folderExclusionTerms` builds the term.
   *
   * Empty by default, and deliberately not just `excludedDirectories`: pruning
   * here happens before the candidate budget is spent (a 300-row page of a
   * Unity project lost 23% of its rows to post-hoc exclusion, and the budget is
   * what decides whether a real match is even seen), but each term measurably
   * slows the query — 56 ms with none, 83 ms with one, 115 ms with two on a 470k
   * -entry tree with client 1.1.0.26. Put the two or three fattest generated
   * trees here and leave the rest to `excludedDirectories`.
   */
  excludeInQuery: string[]
  /**
   * File-name patterns pruned inside the Everything query.
   *
   * The same shape as {@link excludeInQuery} — a plain name or pattern, no `!` —
   * but Everything parses a file exclusion differently from a folder one, so the
   * two lists stay separate rather than making the user guess which they meant.
   * `*.meta` is a file pattern; `Library` here would mean "a *file* named
   * Library", which is why the card labels the fields instead of merging them.
   *
   * Empty by default: which generated files are noise depends on the toolchain
   * (`*.meta` for Unity, `*.pyc` for Python, `*.g.dart` for Dart).
   */
  excludeFilePatterns: string[]
  /**
   * Allow a fuzzy subsequence search when a query has no contiguous match.
   *
   * Everything answers the wildcard subsequence form from its index in
   * ~90–150 ms, so this is on by default; it stays a switch because a
   * deployment that prefers never widening a query can turn it off.
   */
  fuzzyFallback: boolean
  /**
   * Directories searched for a bare `esCommand` before the inherited `PATH`.
   * Covers portable and per-user installations the `PATH` does not carry.
   */
  extraPathDirectories: string[]
  /**
   * Install the model-facing `@path` guidance section.
   *
   * The section is the seam's stable `FILE_REFERENCE_PROMPT`; it is installed
   * only when the addressed agent can actually call `read`, matching the
   * shipped provider, so a session without filesystem tools is not told about
   * paths it cannot open.
   *
   * It governs that section only. The `find_files` guidance has no switch — a
   * user must not have to know the tool exists for the model to be told about it.
   */
  installPrompt: boolean
}

/**
 * The defaults, in one place.
 *
 * `normalizeConfig` needs them for a caller that passed a partial object, and the
 * schema needs the same numbers; keeping one table stops the two from drifting.
 */
export const DEFAULT_CONFIG = {
  esCommand: 'es.exe',
  maxResults: 20,
  maxCandidates: 300,
  timeoutMs: 10000,
  deadlineMs: 25000,
  excludedDirectories: DEFAULT_EXCLUDED_DIRECTORIES,
  excludeInQuery: [],
  excludeFilePatterns: [],
  fuzzyFallback: true,
  extraPathDirectories: [],
  installPrompt: true,
} as const satisfies Config

/**
 * Read the current value of a configuration field that may be a live handle.
 *
 * Every field of this plugin's Config is `volatile`, and the Loader gives such a
 * field to `apply` as `Object.freeze({ get })` rather than as the value. Anything
 * that inspects a field — validation included — has to go through `.get()`, or it
 * sees an object where it expected a number and rejects a perfectly good
 * configuration. That mistake kept this bundle from activating at all once, so the
 * unwrapping lives in one exported place and every reader uses it.
 *
 * @param value - a field value, possibly a volatile handle.
 * @returns the value currently in effect.
 */
export function currentValue<T>(value: T): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function'
  ) {
    return (value as unknown as { get(): T }).get()
  }
  return value
}

/**
 * Render a rejected configuration value for an error message.
 *
 * A rejected number is most usefully reported by type when it is an object,
 * because the common mistake is a volatile handle arriving where a value was
 * expected.
 *
 * @param value - the value that failed validation.
 * @returns a short, unambiguous rendering.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : String(value)
}

/**
 * Validate configuration the Loader may have handed through unvalidated.
 *
 * Two rules, both learned the hard way:
 *
 * 1. **Validation reads through handles** via {@link currentValue}, because every
 *    field is volatile.
 * 2. **The result keeps the handles.** Returning unwrapped copies here would pin
 *    the first value forever and quietly break the whole point of `volatile` —
 *    a card edit would stop reaching the provider and the tool.
 *
 * @param config - raw configuration, with volatile fields as live handles.
 * @returns the same configuration with any omitted field defaulted.
 */
export function normalizeConfig(config: Config): Config {
  /** One field's current value, with the schema's default applied. */
  const read = <K extends keyof Config>(key: K): Config[K] => {
    const value = currentValue((config as unknown as Record<string, unknown>)[key])
    if (value !== undefined) return value as Config[K]
    return DEFAULT_CONFIG[key]
  }

  const maxResults = read('maxResults')
  const maxCandidates = read('maxCandidates')
  const timeoutMs = read('timeoutMs')
  const deadlineMs = read('deadlineMs')
  if (!Number.isSafeInteger(maxResults) || maxResults <= 0) {
    throw new Error(
      `dsh-at-file-everything: maxResults must be a positive safe integer (got ${describeValue(maxResults)})`,
    )
  }
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
    throw new Error(
      `dsh-at-file-everything: maxCandidates must be a positive safe integer (got ${describeValue(maxCandidates)})`,
    )
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `dsh-at-file-everything: timeoutMs must be a positive safe integer (got ${describeValue(timeoutMs)})`,
    )
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error(
      `dsh-at-file-everything: deadlineMs must be a positive safe integer (got ${describeValue(deadlineMs)})`,
    )
  }
  // A deadline below the database-load wait could only ever kill a query the
  // client was still legitimately waiting on, so the two are cross-checked.
  if (deadlineMs <= timeoutMs) {
    throw new Error('dsh-at-file-everything: deadlineMs must exceed timeoutMs')
  }
  const excludedDirectories = read('excludedDirectories')
  if (excludedDirectories.some((entry) => entry === '' || /[\\/"<>|&^]/.test(entry))) {
    throw new Error(
      'dsh-at-file-everything: excludedDirectories entries must be folder-name patterns ([\\/"<>|&^] are refused)',
    )
  }
  // These are folder-name PATTERNS: `*` and `?` are the point, because the user
  // writes `Lib*` rather than knowing the query syntax. What is refused is
  // anything that would split the term (a separator), or that Everything reads as
  // an operator rather than as part of a name.
  const excludeInQuery = read('excludeInQuery')
  if (excludeInQuery.some((entry) => entry === '' || /[\\/"<>|&^]/.test(entry))) {
    throw new Error(
      'dsh-at-file-everything: excludeInQuery entries must be folder-name patterns ([\\/"<>|&^] are refused; * and ? are allowed)',
    )
  }
  // The same rule for file-name patterns, so the two lists behave identically for
  // the user instead of each having its own dialect.
  const excludeFilePatterns = read('excludeFilePatterns')
  if (excludeFilePatterns.some((entry) => entry === '' || /[\\/"<>|&^]/.test(entry))) {
    throw new Error(
      'dsh-at-file-everything: excludeFilePatterns entries must be file-name patterns ([\\/"<>|&^] are refused; * and ? are allowed)',
    )
  }
  const esCommand = read('esCommand')
  if (esCommand.trim() === '') throw new Error('dsh-at-file-everything: esCommand must not be empty')

  // Hand back the caller's own object, filling in only what it omitted. The
  // handles survive, so a later `live()` read still sees card edits.
  const normalized: Record<string, unknown> = { ...(config as unknown as Record<string, unknown>) }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (normalized[key] !== undefined) continue
    const fallback = DEFAULT_CONFIG[key as keyof Config]
    // Copy the array defaults: handing out the module-level array would let one
    // consumer's `push` change the default for every later load.
    normalized[key] = Array.isArray(fallback) ? [...fallback] : fallback
  }
  return normalized as unknown as Config
}
