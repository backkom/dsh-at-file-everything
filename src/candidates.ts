/**
 * Path normalisation, exclusion filtering, and ranking for the Everything-backed
 * `@file` provider.
 *
 * Everything reports host-form absolute paths (`Y:\work\a\b.ts`) while the
 * `@file` grammar and the model-facing tools speak workspace-relative form
 * (`a/b.ts`) with forward slashes. Everything also emits directories and files
 * as independent rows, so the raw set needs the ordering guarantees the shipped
 * provider gives: exact basename first, then prefix, then substring, then fuzzy,
 * with directories ahead of files at equal scores.
 *
 * Everything here is pure, which is what lets the ranking be tested without an
 * Everything installation.
 *
 * @module dsh-at-file-everything/candidates
 */

import { win32 } from 'node:path'

/** A path-only completion candidate, matching the seam's candidate shape. */
export interface Candidate {
  /** Workspace-relative path with `/` separators. */
  path: string
  /** Discriminant the `@file` grammar uses for trailing-slash rendering. */
  kind: 'file' | 'directory'
}

/** One Everything row after conversion to the seam's vocabulary. */
export interface RawCandidate {
  /** Path relative to the workspace root with `/` separators. */
  path: string
  /** Final path segment. */
  name: string
  /** Whether the row is a directory. */
  kind: 'file' | 'directory'
}

/**
 * Read the final path segment of a `\`- or `/`-separated path.
 *
 * A Windows root such as `C:\` has no basename, and neither does an empty
 * string, so both answer `undefined` rather than `''`.
 *
 * @param path - path in either separator style.
 * @returns the final segment, or `undefined` when there is none.
 */
export function basenameOf(path: string): string | undefined {
  const normalized = path.replaceAll('/', '\\').replace(/\\+$/, '')
  if (normalized === '') return undefined
  const index = normalized.lastIndexOf('\\')
  const name = index < 0 ? normalized : normalized.slice(index + 1)
  if (name === '' || /^[A-Za-z]:$/.test(name)) return undefined
  return name
}

/**
 * Join a normalized root with relative segments.
 *
 * The result is normalized, so `.`/`..` segments in caller-supplied text are
 * resolved here rather than reaching Everything as literal segments. A path
 * that climbs out of the root is still returned as an absolute path — callers
 * pair this with {@link isWithin} — but it is returned in a form whose text is
 * honest about where it points.
 *
 * @param root - absolute workspace root, no trailing separator.
 * @param segments - path segments below the root.
 * @returns an absolute, normalized Windows path; the root when there are no segments.
 */
export function toWindowsPath(root: string, readonlySegments: readonly string[]): string {
  if (readonlySegments.length === 0) return normalizeWindowsPath(root)
  return normalizeWindowsPath(`${root}\\${readonlySegments.join('\\')}`)
}

/**
 * Decide whether a joined path still lies inside the workspace root.
 *
 * The `@file` grammar lets a user type any path text, including `../sibling/`
 * or an absolute `D:\elsewhere\`. Joining that onto the root and handing it to
 * Everything would turn completion into a directory reader for the whole
 * machine, which is exactly what scoping the queries is meant to prevent. This
 * guard keeps directory descent inside the workspace.
 *
 * Both sides are normalized first: a plain prefix test would accept
 * `C:\work\..\other`, whose text still starts with `C:\work\`.
 *
 * @param root - normalized absolute workspace root.
 * @param candidate - absolute path built from user text.
 * @returns `true` when `candidate` is the root or a descendant of it.
 */
export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeWindowsPath(root)
  const normalizedCandidate = normalizeWindowsPath(candidate)
  const prefix = `${normalizedRoot}\\`
  if (normalizedCandidate.length < prefix.length) {
    return normalizedCandidate.toLowerCase() === normalizedRoot.toLowerCase()
  }
  return normalizedCandidate.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
}

/**
 * Collapse `.`/`..` segments and unify separators without touching the disk.
 *
 * `path.win32.normalize` keeps a trailing separator, and a bare root (`C:\`)
 * must stay exactly that rather than becoming an empty string.
 *
 * @param value - path text.
 * @returns a normalized absolute Windows path.
 */
function normalizeWindowsPath(value: string): string {
  const unified = value.replaceAll('/', '\\')
  const normalized = win32.normalize(unified)
  return normalized.length > 1 ? normalized.replace(/\\+$/, '') : normalized
}

/**
 * Convert an absolute Everything result path to workspace-relative form.
 *
 * Comparison is case-insensitive because Windows paths are, and Everything
 * echoes the spelling in its index, which can differ in case from the directory
 * the agent was started in.
 *
 * @param root - absolute workspace root without a trailing separator.
 * @param absolute - absolute path reported by Everything.
 * @returns the relative path with `/` separators, or `undefined` when the path
 *   is not a strict descendant of the root.
 */
export function relativeToRoot(root: string, absolute: string): string | undefined {
  const prefix = `${root}\\`
  if (absolute.length <= prefix.length) return undefined
  if (absolute.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return undefined
  return absolute.slice(prefix.length).replaceAll('\\', '/')
}

/**
 * Decide whether one folder name matches an exclusion pattern.
 *
 * The card accepts `Library` and `Lib*` alike, so the comparison has to
 * understand wildcards. Only `*` and `?` are meaningful — the same two Everything
 * honours — and everything else is literal. The match is case-insensitive because
 * Windows folder names are.
 *
 * @param segment - one path segment.
 * @param patterns - lower-cased patterns, possibly containing `*` and `?`.
 * @returns whether the segment is excluded.
 */
export function matchesExcluded(segment: string, patterns: ReadonlySet<string>): boolean {
  if (patterns.size === 0) return false
  const name = segment.toLowerCase()
  // A plain name is the common case and costs no regular expression.
  if (patterns.has(name)) return true
  for (const pattern of patterns) {
    if (!pattern.includes('*') && !pattern.includes('?')) continue
    if (wildcardMatches(name, pattern)) return true
  }
  return false
}

/**
 * Match one name against a `*`/`?` pattern.
 *
 * Implemented as an anchored regular expression over an escaped literal, so a
 * pattern can never be read as a regex by accident — a folder named `a+b` must
 * match `a+b`, not `aab`.
 *
 * @param name - lower-cased candidate name.
 * @param pattern - lower-cased pattern.
 * @returns whether the pattern matches the whole name.
 */
function wildcardMatches(name: string, pattern: string): boolean {
  const source = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '.*'
      if (character === '?') return '.'
      return character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  try {
    return new RegExp(`^${source}$`).test(name)
  } catch {
    // An unusable pattern must not fail a keystroke; treat it as no match.
    return false
  }
}

/**
 * Drop rows living under an excluded folder.
 *
 * The shipped provider skips excluded trees while walking; Everything's index
 * already contains them, so exclusion becomes a filter over the rows that were
 * actually returned. The entry's own segment is only checked for folders: a
 * *file* named `build` is not an excluded folder.
 *
 * @param rows - root-relative rows.
 * @param excluded - lower-cased folder patterns to drop.
 * @returns rows whose every directory segment is retained.
 */
export function filterExcluded(rows: readonly RawCandidate[], excluded: ReadonlySet<string>): RawCandidate[] {
  if (excluded.size === 0) return [...rows]
  return rows.filter((row) => {
    const segments = row.path.split('/')
    const directories = row.kind === 'directory' ? segments : segments.slice(0, -1)
    return !directories.some((segment) => matchesExcluded(segment, excluded))
  })
}

/**
 * Rank candidates for one query and keep the best `limit`.
 *
 * The tiers mirror `@deepseek-ai/dsh-file-reference-local` so that switching
 * providers does not change which file a keystroke sequence selects: an exact
 * basename beats a prefix, which beats a substring, which beats a fuzzy
 * subsequence; directories lead files at equal scores, then shorter paths lead
 * longer ones, then code-unit order breaks the remaining ties.
 *
 * @param rows - root-relative rows, already filtered.
 * @param query - text typed after `@`, `/`-separated.
 * @param limit - maximum candidates to return.
 * @returns deterministically ordered candidates.
 */
export function rank(rows: readonly RawCandidate[], query: string, limit: number): Candidate[] {
  const needle = query.slice(query.lastIndexOf('/') + 1).toLowerCase()
  const scored: { row: RawCandidate; score: number }[] = []
  for (const row of rows) {
    const score = scoreCandidate(row, needle)
    if (score !== undefined) scored.push({ row, score })
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      kindRank(left.row.kind) - kindRank(right.row.kind) ||
      (needle === '' ? 0 : left.row.path.length - right.row.path.length) ||
      compareText(left.row.path, right.row.path),
  )

  return scored.slice(0, limit).map(({ row }) => ({ path: row.path, kind: row.kind }))
}

/**
 * Score one candidate against a lower-cased query fragment.
 *
 * A match on the final segment always outranks a match anywhere else in the
 * path: `@deep` should offer a file *named* `deep.ts` before a file that merely
 * lives under a `deep/` directory, which is what a user typing a file name
 * means. The tier bands are wide enough that the directory bonus can never
 * cross a band.
 *
 * @param row - candidate row.
 * @param needle - lower-cased query fragment, possibly empty.
 * @returns a comparable score, or `undefined` when the row does not match.
 */
function scoreCandidate(row: RawCandidate, needle: string): number | undefined {
  const directoryBonus = row.kind === 'directory' ? 25 : 0
  if (needle === '') return directoryBonus
  const name = row.name.toLowerCase()
  const path = row.path.toLowerCase()
  if (name === needle) return 1000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 800 + directoryBonus
  // Below every basename band: a path-only match is a weaker signal than any
  // match on the name itself.
  if (path.includes(needle)) return 600 + directoryBonus
  const fuzzy = subsequenceScore(path, needle)
  return fuzzy === undefined ? undefined : 400 + fuzzy + directoryBonus
}

/**
 * Score how tightly `query` embeds as a subsequence of `target`.
 * @param target - lower-cased candidate path.
 * @param query - lower-cased query fragment.
 * @returns `0..100`, higher for tighter matches, or `undefined` when absent.
 */
function subsequenceScore(target: string, query: string): number | undefined {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

/**
 * Order directories before files when scores tie.
 * @param kind - candidate kind.
 * @returns the sort rank.
 */
function kindRank(kind: 'file' | 'directory'): number {
  return kind === 'directory' ? 0 : 1
}

/**
 * Compare two strings by code unit, deterministically.
 * @param left - first value.
 * @param right - second value.
 * @returns negative, zero, or positive.
 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
