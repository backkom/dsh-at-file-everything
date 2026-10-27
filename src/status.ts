/**
 * The host half of the configuration card: report which `es.exe` is in effect.
 *
 * A card that only offered a text field would leave the operator guessing — is
 * the bundled copy running, their own install, or nothing at all? The resolution
 * chain has three tiers and its answer is a runtime fact, not a configuration
 * value, so it cannot be derived from the settings form: it must be asked for.
 *
 * The route is registered on this bundle's own prefix. A third-party bundle owns
 * no Remote namespace of its own (`ctx.remote` belongs to the packages the
 * installation ships), so a plain `webServer` route is the mechanism available;
 * it is also enough, because the answer is one small JSON object.
 *
 * @module dsh-at-file-everything/status
 */

import { execFile } from 'node:child_process'

import { resolveEsCommands, type EsCandidate } from './resolve.js'

/** Route this card's requests ride. */
export const STATUS_ROUTE = '/dsh-at-file-everything/api/es-status'

/** One candidate, as the card sees it. */
export interface EsStatusEntry {
  /** Absolute path. */
  path: string
  /** Which tier supplied it: `configured`, `path`, or `bundled`. */
  source: string
}

/** The card's view of the resolution chain. */
export interface EsStatus {
  /**
   * Every candidate that exists, in the order it will be tried.
   *
   * A list rather than a single path: the chain falls through a candidate that
   * cannot be spawned, so the operator benefits from seeing what would be tried
   * next rather than only the winner.
   */
  candidates: EsStatusEntry[]
  /** The path that will actually run, when any exists. */
  effective: string | undefined
  /** Where `effective` came from, which is the useful half of the answer. */
  source: string | undefined
  /**
   * The client's own version, as `es.exe -version` reports it.
   *
   * Absent when the binary exists but would not answer: a client that cannot even
   * print its version is a different problem from no client at all, and the card
   * says "unknown" rather than inventing one.
   */
  version?: string
  /** Whether the operator has pinned a path of their own. */
  overridden: boolean
}

/**
 * Versions already resolved, keyed by executable path.
 *
 * The card re-asks on mount and after every save, and spawning a process each time
 * would put a ~60 ms child launch in front of a readout that almost never changes.
 * The cache lives for the process, which is right: a different binary means a
 * different path, and an upgraded binary in place is rare enough to be worth one
 * restart.
 */
const versionCache = new Map<string, string | undefined>()

/**
 * Read one `es.exe` client's version.
 *
 * `-version` prints a bare dotted version and needs neither Everything nor its
 * service to be running, so this works even when the index is unavailable — which
 * is exactly when the operator is inspecting the card.
 *
 * @param command - absolute path to the client.
 * @param timeoutMs - how long the probe may take before it is abandoned.
 * @returns the version string, or undefined when it could not be read.
 */
export async function esVersion(command: string, timeoutMs = 4000): Promise<string | undefined> {
  if (versionCache.has(command)) return versionCache.get(command)
  const version = await new Promise<string | undefined>((resolve) => {
    try {
      execFile(command, ['-version'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error !== null) {
          resolve(undefined)
          return
        }
        // Keep the first dotted token: some builds append build metadata.
        const match = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(String(stdout))
        resolve(match?.[1])
      })
    } catch {
      // Spawning can throw synchronously for an unusable path.
      resolve(undefined)
    }
  })
  versionCache.set(command, version)
  return version
}

/**
 * Build the status for the current configuration.
 *
 * @param esCommand - the configured command: a path, a bare name, or empty.
 * @param extraPathDirectories - directories searched before `PATH`.
 * @returns the resolution chain as the card renders it.
 */
export function esStatus(esCommand: string, extraPathDirectories: readonly string[]): EsStatus {
  const candidates = resolveEsCommands(esCommand, extraPathDirectories)
  const effective = candidates[0]
  return {
    candidates: candidates.map((candidate: EsCandidate) => ({
      path: candidate.path,
      source: candidate.source,
    })),
    effective: effective?.path,
    source: effective?.source,
    // A bare name is the default rather than a choice; only a path the operator
    // actually typed (or picked) counts as an override.
    overridden: esCommand.trim() !== '' && esCommand.trim() !== 'es.exe',
  }
}

/**
 * Serialise one status answer.
 * @param status - the status to send.
 * @returns the JSON body.
 */
export function statusBody(status: EsStatus): string {
  return JSON.stringify(status)
}
