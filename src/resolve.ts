/**
 * Locating a usable `es.exe`.
 *
 * Everything and its command-line client are separate installs: the service and
 * its index are one download, `es.exe` is another, and plenty of machines run
 * Everything without ever installing the client. A provider that only looked on
 * `PATH` would therefore answer nothing on most of its target machines, which is
 * why this module resolves a chain and why the package ships a pinned copy as its
 * last resort.
 *
 * The order is deliberate:
 *
 * 1. `esCommand`, when it names a file. An explicit answer always wins, so a
 *    deployment can point at a copy it manages.
 * 2. A bare `esCommand` (the default `es.exe`) resolved through
 *    `extraPathDirectories` and then the inherited `PATH`. A user who installed
 *    the client expects *their* client to be used: it is the one that matches
 *    their Everything build.
 * 3. The bundled `bin/es.exe`. Its position after `PATH` is the point: it is the
 *    fallback for the machine that has Everything but no client at all, not an
 *    override for the machine that already has a working one.
 *
 * Each candidate is probed with `existsSync` + `statSync` inside a `try`, because
 * a path can exist and still be unreadable — a denied ACL entry, a dangling
 * reparse point — and resolution must fall through rather than throw at load.
 *
 * @module dsh-at-file-everything/resolve
 */

import { existsSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where a resolved `es.exe` came from, for logging and diagnostics. */
export type EsSource = 'configured' | 'path' | 'bundled'

/** One resolved candidate. */
export interface EsCandidate {
  /** Absolute path to the executable. */
  path: string
  /** Which rule supplied it. */
  source: EsSource
}

/** Package root, so the bundled copy can be found relative to the built entry. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The `es.exe` this package ships.
 *
 * Pinned rather than tracking the newest release on purpose: see `bin/README.md`
 * for the measured reason and the version table behind it.
 */
export function bundledEsCommand(): string {
  return join(PACKAGE_ROOT, 'bin', 'es.exe')
}

/**
 * Whether a path names a readable regular file.
 * @param path - candidate path.
 * @returns `true` only when it exists and is a file.
 */
function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve `es.exe` candidates in priority order.
 *
 * Every candidate that exists is returned, in the order it should be tried, so a
 * configured path that has since been uninstalled costs one failed spawn instead
 * of a silent empty completion list.
 *
 * @param command - configured `esCommand`; a bare name resolves through `PATH`.
 * @param extraPathDirectories - directories searched for a bare name, ahead of `PATH`.
 * @returns the candidates to try, empty when nothing usable exists.
 */
export function resolveEsCommands(
  command: string,
  extraPathDirectories: readonly string[] = [],
): EsCandidate[] {
  const candidates: EsCandidate[] = []
  const configured = command.trim()

  if (configured !== '' && isAbsolute(configured)) {
    if (isFile(configured)) candidates.push({ path: configured, source: 'configured' })
  } else {
    const name = configured === '' ? 'es.exe' : configured
    for (const directory of extraPathDirectories) {
      const candidate = join(directory, name)
      if (isFile(candidate)) {
        candidates.push({ path: candidate, source: 'configured' })
        break
      }
    }
    // `PATH` is searched only when the extra directories did not already answer,
    // so an explicitly provided directory is not silently outranked.
    if (candidates.length === 0) {
      for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (directory === '') continue
        const candidate = join(directory, name)
        if (isFile(candidate)) {
          candidates.push({ path: candidate, source: 'path' })
          break
        }
      }
    }
  }

  const bundled = bundledEsCommand()
  if (isFile(bundled) && !candidates.some((entry) => entry.path === bundled)) {
    candidates.push({ path: bundled, source: 'bundled' })
  }

  return candidates
}
