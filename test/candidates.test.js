/**
 * Unit tests for the pure ranking and path-normalisation helpers.
 *
 * These run everywhere: no Everything installation, no Windows, no child
 * process. They pin the ordering contract that must stay identical to the
 * shipped `@deepseek-ai/dsh-file-reference-local` provider, because changing it
 * silently changes which file a keystroke sequence selects.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  basenameOf,
  filterExcluded,
  isWithin,
  rank,
  relativeToRoot,
  toWindowsPath,
} from '../lib/pure.js'

/** Build a row with a directory/file discriminant. */
const row = (path, kind = 'file') => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind,
})

describe('basenameOf', () => {
  it('reads the final segment of either separator style', () => {
    assert.equal(basenameOf('a/b/c.ts'), 'c.ts')
    assert.equal(basenameOf('a\\b\\c.ts'), 'c.ts')
    assert.equal(basenameOf('c.ts'), 'c.ts')
  })

  it('tolerates a trailing separator', () => {
    assert.equal(basenameOf('a/b/'), 'b')
    assert.equal(basenameOf('a\\b\\'), 'b')
  })

  it('answers undefined for values with no basename', () => {
    assert.equal(basenameOf(''), undefined)
    assert.equal(basenameOf('\\'), undefined)
    assert.equal(basenameOf('C:/'), undefined)
    assert.equal(basenameOf('C:'), undefined)
  })
})

describe('toWindowsPath', () => {
  it('returns the root unchanged when there are no segments', () => {
    assert.equal(toWindowsPath('C:\\work', []), 'C:\\work')
  })

  it('joins segments with backslashes', () => {
    assert.equal(toWindowsPath('C:\\work', ['a', 'b']), 'C:\\work\\a\\b')
  })
})

describe('isWithin', () => {
  it('accepts the root itself', () => {
    assert.equal(isWithin('C:\\work', 'C:\\work'), true)
  })

  it('accepts a descendant', () => {
    assert.equal(isWithin('C:\\work', 'C:\\work\\a\\b'), true)
  })

  it('compares case-insensitively', () => {
    assert.equal(isWithin('C:\\work', 'c:\\WORK\\a'), true)
  })

  it('rejects a sibling reached by ..', () => {
    assert.equal(isWithin('C:\\work', 'C:\\work\\..\\other'), false)
  })

  it('rejects an absolute path on another root', () => {
    assert.equal(isWithin('C:\\work', 'D:\\elsewhere'), false)
  })

  it('rejects a name that only shares a prefix', () => {
    assert.equal(isWithin('C:\\work', 'C:\\workbench\\a'), false)
  })

  it('rejects a parent path', () => {
    assert.equal(isWithin('C:\\work\\sub', 'C:\\work'), false)
  })
})

describe('relativeToRoot', () => {
  it('strips the root and switches to forward slashes', () => {
    assert.equal(relativeToRoot('C:\\work', 'C:\\work\\a\\b.ts'), 'a/b.ts')
  })

  it('compares the root case-insensitively', () => {
    assert.equal(relativeToRoot('C:\\work', 'c:\\WORK\\a.ts'), 'a.ts')
  })

  it('rejects paths outside the root', () => {
    assert.equal(relativeToRoot('C:\\work', 'C:\\other\\a.ts'), undefined)
    assert.equal(relativeToRoot('C:\\work', 'C:\\workbench\\a.ts'), undefined)
  })

  it('rejects the root itself and shorter paths', () => {
    assert.equal(relativeToRoot('C:\\work', 'C:\\work'), undefined)
    assert.equal(relativeToRoot('C:\\work', 'C:\\wor'), undefined)
  })
})

describe('filterExcluded', () => {
  const excluded = new Set(['node_modules', 'build'])

  it('drops rows under an excluded directory', () => {
    const rows = [row('src/a.ts'), row('node_modules/pkg/i.js'), row('build/o.js')]
    assert.deepEqual(
      filterExcluded(rows, excluded).map((entry) => entry.path),
      ['src/a.ts'],
    )
  })

  it('drops an excluded directory itself', () => {
    const rows = [row('node_modules', 'directory'), row('src', 'directory')]
    assert.deepEqual(
      filterExcluded(rows, excluded).map((entry) => entry.path),
      ['src'],
    )
  })

  it('keeps a file whose own name matches an excluded directory name', () => {
    const rows = [row('src/build')]
    assert.deepEqual(
      filterExcluded(rows, excluded).map((entry) => entry.path),
      ['src/build'],
    )
  })

  it('matches excluded names case-insensitively', () => {
    const rows = [row('Node_Modules/pkg/i.js')]
    assert.deepEqual(filterExcluded(rows, excluded), [])
  })

  it('is a no-op for an empty exclusion set', () => {
    const rows = [row('node_modules/pkg/i.js')]
    assert.deepEqual(filterExcluded(rows, new Set()), rows)
  })

  it('honours a wildcard pattern, which is what the card asks the user to type', () => {
    // The card accepts `Lib*`; without wildcard matching here the entry would
    // look configured but do nothing. `Lib*` is a prefix, so it takes both.
    const rows = [
      row('Library/pkg/i.js'),
      row('LibraryBeta/b.js'),
      row('Assets/keep.cs'),
    ]
    assert.deepEqual(
      filterExcluded(rows, new Set(['lib*'])).map((entry) => entry.path),
      ['Assets/keep.cs'],
    )
  })

  it('narrows with ? where * would be too wide', () => {
    const rows = [row('Library/i.js'), row('LibraryBeta/b.js')]
    assert.deepEqual(
      filterExcluded(rows, new Set(['library'])).map((entry) => entry.path),
      ['LibraryBeta/b.js'],
    )
  })

  it('matches ? as one character', () => {
    const rows = [row('Temp1/a.txt'), row('Temp12/a.txt')]
    assert.deepEqual(
      filterExcluded(rows, new Set(['temp?'])).map((entry) => entry.path),
      ['Temp12/a.txt'],
    )
  })

  it('treats regex metacharacters in a pattern as literals', () => {
    // A folder really can be named `a+b`; matching it must not also match `aab`.
    const rows = [row('a+b/x.txt'), row('aab/x.txt')]
    assert.deepEqual(
      filterExcluded(rows, new Set(['a+b'])).map((entry) => entry.path),
      ['aab/x.txt'],
    )
  })

  it('anchors the pattern, so a prefix does not exclude a longer name', () => {
    const rows = [row('build/x.js'), row('buildtools/y.js')]
    assert.deepEqual(
      filterExcluded(rows, new Set(['build'])).map((entry) => entry.path),
      ['buildtools/y.js'],
    )
  })
})

describe('rank', () => {
  it('prefers an exact basename over a prefix match', () => {
    const rows = [row('src/prefecture.ts'), row('src/pref.ts')]
    assert.deepEqual(
      rank(rows, 'pref', 10).map((entry) => entry.path),
      ['src/pref.ts', 'src/prefecture.ts'],
    )
  })

  it('prefers a prefix match over a substring match', () => {
    const rows = [row('src/apref.ts'), row('src/prefabc.ts')]
    assert.deepEqual(
      rank(rows, 'pref', 10).map((entry) => entry.path),
      ['src/prefabc.ts', 'src/apref.ts'],
    )
  })

  it('prefers a basename match over a directory-only match', () => {
    const rows = [row('pref/deep/other.ts'), row('src/thing.ts')]
    assert.deepEqual(
      rank(rows, 'pref', 10).map((entry) => entry.path),
      ['pref/deep/other.ts'],
    )
  })

  it('orders directories before files at equal scores', () => {
    const rows = [row('src/pref', 'file'), row('other/pref', 'directory')]
    const ranked = rank(rows, 'pref', 10)
    assert.equal(ranked[0]?.kind, 'directory')
  })

  it('prefers a shorter path when both rows match on the name', () => {
    const rows = [row('a/b/c/deep.ts'), row('a/deep.ts')]
    const ranked = rank(rows, 'deep', 10)
    assert.equal(ranked[0]?.path, 'a/deep.ts')
  })

  it('prefers a name match over a directory-segment match', () => {
    const rows = [row('a/deep/c/long-name.ts'), row('a/other/deep.ts')]
    const ranked = rank(rows, 'deep', 10)
    assert.equal(ranked[0]?.path, 'a/other/deep.ts')
  })

  it('falls back to a fuzzy subsequence match', () => {
    const rows = [row('src/FileDockTest.cs')]
    assert.deepEqual(
      rank(rows, 'fdt', 10).map((entry) => entry.path),
      ['src/FileDockTest.cs'],
    )
  })

  it('rejects rows that do not match at all', () => {
    assert.deepEqual(rank([row('src/a.ts')], 'zzzz', 10), [])
  })

  it('respects the result limit', () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(`src/file${String(index)}.ts`))
    assert.equal(rank(rows, 'file', 5).length, 5)
  })

  it('returns every row for an empty query, directories first', () => {
    const rows = [row('src/a.ts'), row('src', 'directory')]
    const ranked = rank(rows, '', 10)
    assert.equal(ranked[0]?.path, 'src')
    assert.equal(ranked[0]?.kind, 'directory')
  })

  it('is deterministic for equal scores', () => {
    const rows = [row('src/b.ts'), row('src/a.ts')]
    assert.deepEqual(
      rank(rows, 'z', 10).map((entry) => entry.path),
      rank([...rows].reverse(), 'z', 10).map((entry) => entry.path),
    )
  })

  it('ranks on the fragment after the last slash', () => {
    const rows = [row('lib/a/index.ts'), row('lib/a/other.ts')]
    assert.deepEqual(
      rank(rows, 'lib/a/index', 10).map((entry) => entry.path),
      ['lib/a/index.ts'],
    )
  })
})
