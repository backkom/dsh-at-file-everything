/**
 * Pure, dependency-free helpers used by the Everything-backed `@file` provider.
 *
 * This entry exists so the ranking contract and the Everything search-syntax
 * builders can be tested — and reused by other providers — without importing
 * the plugin itself, which needs a live Harness installation to resolve
 * `@deepseek-ai/*`. Nothing here touches child processes or the filesystem.
 *
 * @module dsh-at-file-everything/pure
 */

export {
  basenameOf,
  filterExcluded,
  isWithin,
  rank,
  relativeToRoot,
  toWindowsPath,
} from './candidates.js'

export {
  contiguousTerm,
  escapeRegex,
  escapeTerm,
  EsClient,
  parseCsv,
  subsequenceTerm,
} from './es-client.js'

export type { Candidate, RawCandidate } from './candidates.js'
export type { EsFailure, EsRow } from './es-client.js'
