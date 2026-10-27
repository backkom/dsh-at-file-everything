/**
 * Live integration test against a real Everything installation.
 *
 * Skips itself when no `es.exe` answers, so the unit suite stays runnable
 * anywhere. When it does run, it proves the things only a live client can: the
 * export channel decodes non-ASCII paths, directories are distinguishable from
 * files, a query is actually scoped to its root rather than the whole disk, and
 * — the regression this suite exists for now — a directory listing still finds
 * entries whose names sort past the `-n` page, which only stays true while the
 * fragment is answered by Everything rather than by the caller.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { EsClient, bundledEsCommand, contiguousTerm, listingTerm, subsequenceTerm } from '../lib/pure.js'

/** Locate a client to test with: PATH first, then the bundled copy. */
function findEs() {
  if (process.platform !== 'win32') return undefined
  for (const candidate of ['es.exe', bundledEsCommand()]) {
    const probe = spawnSync(candidate, ['-get-everything-version'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0 && /\d+\.\d+/.test(probe.stdout ?? '')) return candidate
  }
  return undefined
}

const esCommand = findEs()

describe('es.exe live integration', { skip: esCommand === undefined ? 'Nothing is answering an es.exe' : false }, () => {
  /** Fixture root created under the real temp directory, which Everything indexes. */
  let root
  /** Client under test. */
  let client

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-atfe-live-'))
    client = new EsClient([esCommand], { timeoutMs: 15000, deadlineMs: 30000 })
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, 'bulk'), { recursive: true })
    await writeFile(join(root, 'src', 'alpha.ts'), 'x')
    await writeFile(join(root, 'src', 'deep', 'gamma.ts'), 'x')
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
    await writeFile(join(root, 'src', '中文测试文件.txt'), 'x')
    await writeFile(join(root, 'src', 'with space.txt'), 'x')
    // Enough children that a 5-row page cannot reach the alphabetically last one.
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(root, 'bulk', `bulk-${String(index).padStart(3, '0')}.txt`), 'x')
    }
    await writeFile(join(root, 'bulk', 'zzz-target.txt'), 'x')
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

  // The regression this suite guards: `-n` caps the rows the client returns, so a
  // fragment applied by the caller after the fact loses every entry whose name
  // sorts past the cap. Asking Everything instead keeps the answer correct
  // regardless of page size.
  it('finds a directory entry whose name sorts past a small page', async () => {
    const rows = await client.query(
      ['-parent', join(root, 'bulk'), '-n', '5', listingTerm('zzz-target')],
      AbortSignal.timeout(20000),
    )
    assert.ok(Array.isArray(rows), `query failed: ${JSON.stringify(rows)}`)
    assert.ok(
      rows.some((row) => row.path.endsWith('zzz-target.txt')),
      `the last-sorting entry was lost: ${JSON.stringify(rows.map((row) => row.path))}`,
    )
  })

  it('lists a directory without a fragment through the wildcard term', async () => {
    const rows = await client.query(
      ['-parent', join(root, 'bulk'), '-n', '5', listingTerm('')],
      AbortSignal.timeout(20000),
    )
    assert.ok(Array.isArray(rows))
    assert.equal(rows.length, 5, 'a blank fragment must still list the directory')
  })

  it('prunes a directory subtree inside the query', async () => {
    const scoped = await client.query(
      ['-path', root, '-n', '50', '!\\node_modules\\', contiguousTerm('index')],
      AbortSignal.timeout(20000),
    )
    assert.ok(Array.isArray(scoped))
    assert.equal(scoped.length, 0, `node_modules was not pruned: ${JSON.stringify(scoped.map((r) => r.path))}`)
  })
})
