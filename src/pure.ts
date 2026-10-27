/**
 * Pure, dependency-free helpers used by the Everything-backed `@file` provider.
 *
 * This entry exists so the ranking contract and the Everything search-syntax
 * builders can be tested — and reused by other providers — without importing
 * the plugin itself, which needs a live Harness installation to resolve
 * `@deepseek-ai/*`. Nothing here touches child processes except through
 * {@link EsClient}, which is exported so the live suite can drive a real client.
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
  folderExclusionTerms,
  fileExclusionTerms,
  listingTerm,
  EsClient,
  parseCsv,
  subsequenceTerm,
} from './es-client.js'

export { bundledEsCommand, resolveEsCommands } from './resolve.js'

export type { Candidate, RawCandidate } from './candidates.js'
export type { EsClientOptions, EsFailure, EsRow } from './es-client.js'
export type { EsCandidate, EsSource } from './resolve.js'
