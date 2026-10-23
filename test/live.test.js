/**
 * Live integration test against a real Everything installation.
 *
 * Skips itself when `es.exe` is absent or the Everything service is not
 * answering, so the unit suite stays runnable anywhere. When it does run, it
 * proves the three things only a live client can: the export channel decodes
 * non-ASCII paths, directories are distinguishable from files, and a query is
 * actually scoped to its root rather than the whole disk.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { EsClient, contiguousTerm, subsequenceTerm } from '../lib/pure.js'

/** Probe once whether a usable Everything service is present. */
function everythingAvailable() {
  if (process.platform !== 'win32') return false
  const probe = spawnSync('es.exe', ['-get-everything-version'], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0 && /\d+\.\d+/.test(probe.stdout ?? '')
}

const available = everythingAvailable()

describe('es.exe live integration', { skip: available ? false : 'Everything is not installed' }, () => {
  /** Fixture root created under the real temp directory, which Everything indexes. */
  let root
  /** Client under test. */
  let client

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-atfe-live-'))
    client = new EsClient('es.exe', 15000)
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'src', 'alpha.ts'), 'x')
    await writeFile(join(root, 'src', 'deep', 'gamma.ts'), 'x')
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
    await writeFile(join(root, 'src', '中文测试文件.txt'), 'x')
    await writeFile(join(root, 'src', 'with space.txt'), 'x')
    // Everything follows the filesystem through its journal, but a fixture
    // written microseconds ago can need a moment before it is queryable. Poll
    // rather than sleep a guessed interval: a fixed delay is either slow on a
    // warm index or flaky on a cold one.
    const deadline = Date.now() + 30000
    for (;;) {
      const probe = await client.query(['-parent', join(root, 'src')], AbortSignal.timeout(20000))
      if (Array.isArray(probe) && probe.length > 0) break
      if (Date.now() > deadline) {
        throw new Error('Everything did not index the fixture within 30 s')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })

  after(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('lists direct children and distinguishes directories from files', async () => {
    const rows = await client.query(['-parent', join(root, 'src')], AbortSignal.timeout(20000))
    assert.ok(Array.isArray(rows), 'query returned a failure')

    const byName = new Map(rows.map((row) => [row.path.slice(row.path.lastIndexOf('\\') + 1), row.directory]))
    assert.equal(byName.get('deep'), true, 'subdirectory was not reported as a directory')
    assert.equal(byName.get('alpha.ts'), false, 'file was reported as a directory')
  })

  it('scopes results to the requested root', async () => {
    const rows = await client.query(['-path', root, '-n', '50', contiguousTerm('alpha')], AbortSignal.timeout(20000))
    assert.ok(Array.isArray(rows))
    for (const row of rows) {
      assert.ok(row.path.startsWith(`${root}\\`), `result escaped the root: ${row.path}`)
    }
    assert.ok(rows.some((row) => row.path.endsWith('alpha.ts')), 'expected alpha.ts in the results')
  })

  it('decodes non-ASCII file names through the UTF-8 export channel', async () => {
    const rows = await client.query(['-path', root, '-n', '50', contiguousTerm('中文')], AbortSignal.timeout(20000))
    assert.ok(Array.isArray(rows))
    assert.deepEqual(
      rows.map((row) => row.path.slice(row.path.lastIndexOf('\\') + 1)),
      ['中文测试文件.txt'],
    )
  })

  it('finds a name containing a space without splitting the term', async () => {
    const rows = await client.query(['-path', root, '-n', '50', contiguousTerm('with space')], AbortSignal.timeout(20000))
    assert.ok(Array.isArray(rows))
    assert.ok(
      rows.some((row) => row.path.endsWith('with space.txt')),
      `expected the spaced name to be found, got ${JSON.stringify(rows.map((row) => row.path))}`,
    )
  })

  it('finds a camel-case name through the subsequence tier', async () => {
    const rows = await client.query(['-path', root, '-n', '50', subsequenceTerm('alphats')], AbortSignal.timeout(20000))
    assert.ok(Array.isArray(rows))
    assert.ok(rows.some((row) => row.path.endsWith('alpha.ts')))
  })

  it('answers an empty list for a query that matches nothing', async () => {
    const rows = await client.query(
      ['-path', root, '-n', '50', contiguousTerm('zzz-no-such-file-zzz')],
      AbortSignal.timeout(20000),
    )
    assert.deepEqual(rows, [])
  })

  it('honours cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await client.query(['-path', root, '-n', '10', '*'], controller.signal)
    assert.ok(!Array.isArray(outcome), 'an aborted query must not report rows')
    assert.equal(outcome.reason, 'aborted')
  })
})
