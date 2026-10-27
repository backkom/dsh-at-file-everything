/**
 * Unit tests for the resolution chain and the query terms it feeds `es.exe`.
 *
 * The chain's order is the whole point of the feature — a bundled client must
 * never outrank a user's own — so these pin the order rather than merely the
 * membership of the list.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  bundledEsCommand,
  fileExclusionTerms,
  folderExclusionTerms,
  listingTerm,
  resolveEsCommands,
} from '../lib/pure.js'

/** Scratch directory holding fake executables. */
let scratch

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-atfe-resolve-'))
})

after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
})

/** Create an empty file that stands in for an `es.exe`. */
async function fakeEs(name) {
  const path = join(scratch, name)
  await writeFile(path, '')
  return path
}

describe('resolveEsCommands', () => {
  it('puts the bundled copy last, so a user install always wins', async () => {
    const own = await fakeEs('own-es.exe')
    const candidates = resolveEsCommands(own, [])
    assert.equal(candidates[0]?.path, own)
    assert.equal(candidates[0]?.source, 'configured')
    const bundled = candidates.find((candidate) => candidate.source === 'bundled')
    assert.ok(bundled, 'the bundled copy must be reachable as a fallback')
    assert.equal(candidates.at(-1)?.source, 'bundled', 'bundled must be the last resort')
  })

  it('searches the extra directories before PATH for a bare name', async () => {
    const directory = await mkdtemp(join(scratch, 'extra-'))
    await writeFile(join(directory, 'es.exe'), '')
    const candidates = resolveEsCommands('es.exe', [directory])
    assert.equal(candidates[0]?.path, join(directory, 'es.exe'))
    assert.equal(candidates[0]?.source, 'configured')
  })

  it('falls through a configured path that no longer exists', () => {
    const candidates = resolveEsCommands(join(scratch, 'gone.exe'), [])
    assert.ok(
      candidates.every((candidate) => candidate.source !== 'configured'),
      'a vanished path must not be reported as the configured candidate',
    )
    assert.ok(candidates.some((candidate) => candidate.source === 'bundled'))
  })

  it('never repeats the bundled copy when it is also on PATH', () => {
    const bundled = bundledEsCommand()
    const candidates = resolveEsCommands(bundled, [])
    assert.equal(candidates.filter((candidate) => candidate.path === bundled).length, 1)
  })

  it('still offers the bundled copy when nothing is configured', () => {
    const candidates = resolveEsCommands('', [])
    assert.ok(candidates.length > 0)
    assert.equal(candidates.at(-1)?.source, 'bundled')
  })
})

describe('bundledEsCommand', () => {
  it('names bin/es.exe beside the package', () => {
    assert.match(bundledEsCommand(), /[\\/]bin[\\/]es\.exe$/)
  })
})

describe('listingTerm', () => {
  it('asks for every name when there is no fragment', () => {
    assert.equal(listingTerm(''), '**')
  })

  it('wraps a fragment so Everything answers it from the index', () => {
    assert.equal(listingTerm('alpha'), '*alpha*')
  })

  it('keeps a fragment free of term-separating spaces', () => {
    assert.equal(listingTerm('with space'), '*with?space*')
  })
})

describe('folderExclusionTerms', () => {
  it('builds a term that prunes the subtree, not just the folder row', () => {
    // `!\Library\` prunes the exact name but silently ignores a pattern
    // (`!\Lib*\` matches nothing), and `!folder:Library` leaves the contents.
    // `!path:*\name\*` is the form that prunes whatever the pattern matches.
    assert.deepEqual(folderExclusionTerms(['Library']), ['!path:*\\Library\\*'])
  })

  it('passes a wildcard through, so the user can type Lib*', () => {
    assert.deepEqual(folderExclusionTerms(['Lib*']), ['!path:*\\Lib*\\*'])
  })

  it('answers one term per entry', () => {
    assert.deepEqual(
      folderExclusionTerms(['Library', 'Output']),
      ['!path:*\\Library\\*', '!path:*\\Output\\*'],
    )
  })

  it('is empty for no exclusions', () => {
    assert.deepEqual(folderExclusionTerms([]), [])
  })
})

describe('fileExclusionTerms', () => {
  it('leaves a file pattern bare, because a separator would make it a path test', () => {
    assert.deepEqual(fileExclusionTerms(['*.meta']), ['!*.meta'])
  })

  it('answers one term per entry', () => {
    assert.deepEqual(fileExclusionTerms(['*.meta', '*.pyc']), ['!*.meta', '!*.pyc'])
  })
})
