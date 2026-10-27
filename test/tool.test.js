/**
 * Unit tests for the `find_files` tool.
 *
 * What is pinned here is the tool's *contract* rather than its plumbing: how a
 * query becomes an Everything term, what a page says about the match set, and
 * which failures become actionable errors. Those are the parts a model depends
 * on, and the parts that go wrong silently — a bad `truncated` flag makes a model
 * report a file as missing, and an unhelpful error makes it retry the same call.
 *
 * The definition is built through `buildFindFilesTool` with a fake host, so the
 * suite needs neither a Harness installation nor an Everything service.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { describe, it } from 'node:test'

// `buildFindFilesTool` reaches for `defineTool` from the Harness, which is not
// installed here. The stub reproduces the one thing the tool relies on — that a
// definition carries its name, parameters, output projection and execute — so the
// suite exercises the real contract without a Harness installation.
const STUB = `
export function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: options.output,
    execute: options.execute,
    presentCall: options.presentCall,
    presentResult: options.presentResult,
  }
}
`
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === '@deepseek-ai/dsh-tools') {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true }
  }
  return next(spec, ctx)
}`))

const {
  MAX_LIMIT,
  DEFAULT_LIMIT,
  buildFindFilesTool,
  clampLimit,
  failureToError,
  renderFindFiles,
  toEntries,
  toolTerm,
} = await import('../lib/tool.js')

describe('toolTerm', () => {
  it('wraps a fragment as a name substring', () => {
    assert.equal(toolTerm('playable'), '*playable*')
  })

  it('treats an empty query or a bare star as "everything in scope"', () => {
    assert.equal(toolTerm(''), '**')
    assert.equal(toolTerm('   '), '**')
    assert.equal(toolTerm('*'), '**')
  })

  it('never emits a space, which would split into two AND-ed terms', () => {
    assert.equal(toolTerm('with space'), '*with?space*')
  })

  it('escapes everything operators, so a name is searched literally', () => {
    assert.equal(toolTerm('a&b'), '*a^&b*')
    assert.equal(toolTerm('a|b'), '*a^|b*')
  })
})

describe('clampLimit', () => {
  it('defaults when the caller names nothing usable', () => {
    assert.equal(clampLimit(undefined), DEFAULT_LIMIT)
    assert.equal(clampLimit(0), DEFAULT_LIMIT)
    assert.equal(clampLimit(-5), DEFAULT_LIMIT)
    assert.equal(clampLimit('nonsense'), DEFAULT_LIMIT)
  })

  it('honours a usable limit', () => {
    assert.equal(clampLimit(10), 10)
    assert.equal(clampLimit(1), 1)
  })

  it('caps at the ceiling rather than letting one call bury the context', () => {
    assert.equal(clampLimit(10_000), MAX_LIMIT)
  })

  it('floors a fraction', () => {
    assert.equal(clampLimit(7.9), 7)
  })
})

describe('toEntries', () => {
  const rows = [
    { path: 'C:\\work\\a.ts', directory: false },
    { path: 'C:\\work\\src', directory: true },
    { path: 'C:\\other\\a.ts', directory: false },
  ]

  it('derives the final segment as the name', () => {
    const entries = toEntries(rows, undefined)
    assert.deepEqual(entries.map((entry) => entry.name), ['a.ts', 'src', 'a.ts'])
  })

  it('keeps the directory flag', () => {
    assert.equal(toEntries(rows, undefined)[1]?.directory, true)
  })

  it('drops rows outside the scope', () => {
    // `-path` is a query hint; a row that merely contains the scope string must
    // not ride along.
    assert.deepEqual(
      toEntries(rows, 'C:\\work').map((entry) => entry.path),
      ['C:\\work\\a.ts', 'C:\\work\\src'],
    )
  })

  it('scopes case-insensitively, because Windows paths are', () => {
    assert.equal(toEntries(rows, 'c:\\WORK').length, 2)
  })

  it('keeps a row that is the scope itself', () => {
    const own = [{ path: 'C:\\work', directory: true }]
    assert.equal(toEntries(own, 'C:\\work').length, 1)
  })

  it('tolerates a scope with separators on either side', () => {
    assert.equal(toEntries(rows, 'C:\\work\\').length, 2)
    assert.equal(toEntries(rows, 'C:/work').length, 2)
  })

  it('drops a row with no name at all', () => {
    assert.deepEqual(toEntries([{ path: '', directory: false }], undefined), [])
    assert.deepEqual(toEntries([{ path: 'C:\\', directory: true }], undefined), [])
  })
})

describe('renderFindFiles', () => {
  it('says so when nothing matched', () => {
    const text = renderFindFiles({ results: [], count: 0, truncated: false })
    assert.equal(text, 'No matches.')
  })

  it('names the scope when the search was confined', () => {
    const text = renderFindFiles({ results: [], count: 0, truncated: false, scope: 'C:\\work' })
    assert.match(text, /C:\\work/)
  })

  it('renders one absolute path per line', () => {
    const text = renderFindFiles({
      results: [
        { path: 'C:\\work\\a.ts', name: 'a.ts', directory: false },
        { path: 'C:\\work\\src', name: 'src', directory: true },
      ],
      count: 2,
      truncated: false,
    })
    assert.match(text, /C:\\work\\a\.ts/)
    assert.match(text, /C:\\work\\src\\/)
  })

  it('marks a folder with a trailing separator, so a file and a folder are distinguishable', () => {
    const text = renderFindFiles({
      results: [{ path: 'C:\\work\\src', name: 'src', directory: true }],
      count: 1,
      truncated: false,
    })
    assert.match(text, /C:\\work\\src\\/)
  })

  it('does not double the separator Everything already wrote', () => {
    // Everything reports a folder with a trailing backslash; appending another
    // renders `\dir\\`, which reads as a literal two-separator path.
    const text = renderFindFiles({
      results: [{ path: 'C:\\work\\src\\', name: 'src', directory: true }],
      count: 1,
      truncated: false,
    })
    assert.ok(text.endsWith('src\\'), `unexpected tail: ${JSON.stringify(text)}`)
    assert.ok(!text.includes('src\\\\'), `separator was doubled: ${JSON.stringify(text)}`)
  })

  it('states when the page is short of the match set', () => {
    // The single most important line for a model: without it, a truncated page
    // reads as a complete answer and the file looks absent.
    const text = renderFindFiles({
      results: [{ path: 'C:\\work\\a.ts', name: 'a.ts', directory: false }],
      count: 1,
      truncated: true,
    })
    assert.match(text, /more than 1 matched/i)
  })

  it('says nothing about truncation on a complete page', () => {
    const text = renderFindFiles({
      results: [{ path: 'C:\\work\\a.ts', name: 'a.ts', directory: false }],
      count: 1,
      truncated: false,
    })
    assert.doesNotMatch(text, /more than/i)
  })
})

describe('failureToError', () => {
  it('names the actionable cause when Everything is not running', () => {
    const error = failureToError({ reason: 'everything-not-running', detail: 'ipc window missing' })
    assert.match(error.message, /Everything is not running/)
    assert.match(error.message, /glob/)
  })

  it('names the alternative on any other failure', () => {
    const error = failureToError({ reason: 'exit-code', detail: 'boom' })
    assert.match(error.message, /boom/)
    assert.match(error.message, /glob/)
  })

  it('reports a cancellation as such', () => {
    assert.match(failureToError({ reason: 'aborted', detail: '' }).message, /cancelled/)
  })
})

describe('the tool definition', () => {
  /** A host whose client answers a fixed row set and records the terms. */
  function fakeHost(rows, failure) {
    const calls = []
    return {
      calls,
      client() {
        return {
          exclusions: ['!\\Library\\', '!*.meta'],
          client: {
            async query(args) {
              calls.push(args)
              return failure ?? rows
            },
          },
        }
      },
    }
  }

  const rows = [
    { path: 'C:\\work\\a.ts', directory: false },
    { path: 'C:\\work\\src', directory: true },
  ]

  /** Load the definition through a stubbed `dsh-tools`. */
  async function build(host) {
    return buildFindFilesTool(host)
  }

  it('registers as find_files', async () => {
    const tool = await build(fakeHost(rows))
    assert.equal(tool.name, 'find_files')
  })

  it('declares the parameters a model needs to page and to narrow', async () => {
    const tool = await build(fakeHost(rows))
    const parameters = tool.parameters ?? {}
    for (const name of ['query', 'path', 'foldersOnly', 'filesOnly', 'limit']) {
      assert.ok(parameters[name], `missing parameter ${name}`)
    }
  })

  it('passes the query term, the page size and the exclusions to the client', async () => {
    const host = fakeHost(rows)
    const tool = await build(host)
    await tool.execute({ query: 'alpha', limit: 5 }, { signal: AbortSignal.timeout(1000) })
    const args = host.calls[0]
    assert.ok(args.includes('-n') && args.includes('5'), `no page size in ${args.join(' ')}`)
    assert.ok(args.includes('*alpha*'), `no term in ${args.join(' ')}`)
    assert.ok(args.includes('!\\Library\\'), `no folder exclusion in ${args.join(' ')}`)
    assert.ok(args.includes('!*.meta'), `no pattern exclusion in ${args.join(' ')}`)
  })

  it('confines the search when a path is given', async () => {
    const host = fakeHost(rows)
    const tool = await build(host)
    await tool.execute({ query: 'a', path: 'C:/work' }, { signal: AbortSignal.timeout(1000) })
    const args = host.calls[0]
    assert.ok(args.includes('-path'), `no scope in ${args.join(' ')}`)
    assert.ok(args.includes('C:\\work'), 'the scope was not normalised to host form')
  })

  it('refuses a call with neither a query nor a path', async () => {
    // Everything would otherwise answer the head of the whole index.
    const tool = await build(fakeHost(rows))
    await assert.rejects(
      () => tool.execute({}, { signal: AbortSignal.timeout(1000) }),
      /needs something to find/,
    )
  })

  it('lists a folder when only the path is given', async () => {
    const host = fakeHost(rows)
    const tool = await build(host)
    const value = await tool.execute({ path: 'C:/work' }, { signal: AbortSignal.timeout(1000) })
    assert.ok(host.calls[0].includes('**'), 'a path-only listing must ask for every name')
    assert.equal(value.count, 2)
  })

  it('adds the folder and file switches when asked', async () => {
    const host = fakeHost(rows)
    const tool = await build(host)
    await tool.execute({ query: 'a', foldersOnly: true }, { signal: AbortSignal.timeout(1000) })
    assert.ok(host.calls[0].includes('/ad'))
    await tool.execute({ query: 'a', filesOnly: true }, { signal: AbortSignal.timeout(1000) })
    assert.ok(host.calls[1].includes('/a-d'))
  })

  it('reports truncation when the page came back full', async () => {
    const full = Array.from({ length: 5 }, (_, index) => ({
      path: `C:\\work\\f${String(index)}.ts`,
      directory: false,
    }))
    const tool = await build(fakeHost(full))
    const value = await tool.execute({ query: 'f', limit: 5 }, { signal: AbortSignal.timeout(1000) })
    assert.equal(value.count, 5)
    assert.equal(value.truncated, true)
  })

  it('reports a complete page when it came back short', async () => {
    const tool = await build(fakeHost(rows))
    const value = await tool.execute({ query: 'a', limit: 50 }, { signal: AbortSignal.timeout(1000) })
    assert.equal(value.truncated, false)
  })

  it('raises an actionable error instead of returning an empty page on failure', async () => {
    const tool = await build(fakeHost(undefined, { reason: 'everything-not-running', detail: 'ipc' }))
    await assert.rejects(
      () => tool.execute({ query: 'a' }, { signal: AbortSignal.timeout(1000) }),
      /Everything is not running/,
    )
  })

  it('projects a page into the search card metadata', async () => {
    const tool = await build(fakeHost(rows))
    const value = await tool.execute({ query: 'a' }, { signal: AbortSignal.timeout(1000) })
    const meta = tool.output.presentationMeta({}, value)
    assert.equal(meta.shape, 'paths')
    assert.deepEqual(meta.paths, ['C:\\work\\a.ts', 'C:\\work\\src'])
    assert.equal(meta.total, 2)
    assert.equal(meta.truncated, false)
  })

  it('presents the card on replay, and declines malformed metadata', async () => {
    const tool = await build(fakeHost(rows))
    const value = await tool.execute({ query: 'a' }, { signal: AbortSignal.timeout(1000) })
    const meta = tool.output.presentationMeta({}, value)

    const card = tool.presentResult({}, { meta })
    assert.equal(card.card, 'search')
    assert.equal(card.shape, 'paths')
    assert.equal(card.paths.length, 2)

    // An older log, or a nested call, carries no projection: fall back to text.
    assert.equal(tool.presentResult({}, {}), undefined)
    assert.equal(tool.presentResult({}, { meta: { paths: 7, truncated: 'yes', total: 1 } }), undefined)
  })

  it('accepts an empty page as a valid card', async () => {
    const tool = await build(fakeHost([]))
    const value = await tool.execute({ query: 'nothing' }, { signal: AbortSignal.timeout(1000) })
    const card = tool.presentResult({}, { meta: tool.output.presentationMeta({}, value) })
    assert.deepEqual(card.paths, [])
    assert.equal(card.total, 0)
    assert.equal(card.truncated, false)
  })
})
