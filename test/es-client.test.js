/**
 * Unit tests for the pure parts of the `es.exe` adapter: CSV parsing and the
 * search-term builders.
 *
 * These pin the two conventions the plugin depends on, both established by
 * probing the real client: every argv element is an independent AND-ed term
 * (so terms are never space-joined), and quoted CSV rows carry a literal
 * filename that may itself contain commas and quotes.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { contiguousTerm, escapeRegex, escapeTerm, parseCsv, subsequenceTerm } from '../lib/pure.js'

describe('parseCsv', () => {
  it('skips the BOM and the header row', () => {
    const text = '\uFEFFAttributes,Filename\r\nA,"C:\\w\\a.ts"\r\n'
    assert.deepEqual(parseCsv(text), [{ path: 'C:\\w\\a.ts', directory: false }])
  })

  it('classifies a D attribute as a directory', () => {
    const text = 'Attributes,Filename\r\nD,"C:\\w\\src"\r\n'
    assert.deepEqual(parseCsv(text), [{ path: 'C:\\w\\src', directory: true }])
  })

  it('classifies a compound attribute containing D as a directory', () => {
    const text = 'Attributes,Filename\r\nHDI,"C:\\w\\.svn"\r\n'
    assert.deepEqual(parseCsv(text), [{ path: 'C:\\w\\.svn', directory: true }])
  })

  it('keeps paths containing commas', () => {
    const text = 'Attributes,Filename\r\nA,"C:\\w\\a, b.txt"\r\n'
    assert.equal(parseCsv(text)[0]?.path, 'C:\\w\\a, b.txt')
  })

  it('unescapes doubled quotes in a path', () => {
    const text = 'Attributes,Filename\r\nA,"C:\\w\\say ""hi"".txt"\r\n'
    assert.equal(parseCsv(text)[0]?.path, 'C:\\w\\say "hi".txt')
  })

  it('keeps non-ASCII paths intact', () => {
    const text = '\uFEFFAttributes,Filename\r\nA,"C:\\w\\中文测试文件.txt"\r\nA,"C:\\w\\日本語.md"\r\n'
    assert.deepEqual(
      parseCsv(text).map((entry) => entry.path),
      ['C:\\w\\中文测试文件.txt', 'C:\\w\\日本語.md'],
    )
  })

  it('answers an empty list for an empty export', () => {
    assert.deepEqual(parseCsv(''), [])
    assert.deepEqual(parseCsv('Attributes,Filename\r\n'), [])
  })

  it('skips a line with unbalanced quoting instead of throwing', () => {
    const text = 'Attributes,Filename\r\nA,"C:\\w\\unterminated\r\nA,"C:\\w\\ok.ts"\r\n'
    assert.deepEqual(
      parseCsv(text).map((entry) => entry.path),
      ['C:\\w\\ok.ts'],
    )
  })
})

describe('escapeRegex', () => {
  it('escapes everything with meaning in the Everything dialect', () => {
    assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c')
    assert.equal(escapeRegex('x[y]z'), 'x\\[y\\]z')
    assert.equal(escapeRegex('a+b?'), 'a\\+b\\?')
    assert.equal(escapeRegex('a(b)'), 'a\\(b\\)')
    assert.equal(escapeRegex('a\\b'), 'a\\\\b')
  })

  it('leaves ordinary text untouched', () => {
    assert.equal(escapeRegex('plain text'), 'plain text')
  })
})

describe('contiguousTerm', () => {
  it('wraps the escaped query in wildcards', () => {
    assert.equal(contiguousTerm('abc'), '*abc*')
  })

  it('escapes Everything control characters with a caret', () => {
    assert.equal(contiguousTerm('a&b'), '*a^&b*')
    assert.equal(contiguousTerm('a|b'), '*a^|b*')
    assert.equal(contiguousTerm('a>b'), '*a^>b*')
  })

  it('never emits a space, because that would split into two AND-ed terms', () => {
    assert.equal(contiguousTerm('a b'), '*a?b*')
  })

  it('is a bare wildcard for an empty query', () => {
    assert.equal(contiguousTerm(''), '**')
  })
})

describe('escapeTerm', () => {
  it('replaces a space with a single-character wildcard', () => {
    assert.equal(escapeTerm('a b'), 'a?b')
  })

  it('escapes Everything boolean operators with a caret', () => {
    assert.equal(escapeTerm('a&b|c<d>e'), 'a^&b^|c^<d^>e')
  })

  it('escapes a literal backslash with the caret escape', () => {
    assert.equal(escapeTerm('a\\b"c'), 'a^\\b^"c')
  })
})

describe('subsequenceTerm', () => {
  it('joins characters with wildcards', () => {
    assert.equal(subsequenceTerm('abc'), '*a*b*c*')
  })

  it('is a bare wildcard for an empty query', () => {
    assert.equal(subsequenceTerm(''), '*')
  })

  it('never emits a space', () => {
    assert.equal(subsequenceTerm('a b'), '*a*?*b*')
  })

  it('matches the camel-case gap a contiguous search misses', () => {
    assert.equal(subsequenceTerm('fdt'), '*f*d*t*')
  })
})
