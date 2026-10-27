/**
 * Unit tests for the configuration card's pure logic and its write path.
 *
 * The card cannot be rendered in Node without a React reconciler, so what is
 * pinned here is the part that can be wrong silently: how a pasted textarea
 * becomes the stored list, and whether a write that did not persist is reported
 * as a failure rather than as a save. The second one matters because a false
 * success is unrecoverable — the user's edit is gone and the old value is still
 * running.
 *
 * `lib/client.cjs.js` is not an ES module: the Web shell evaluates it as a
 * script and it registers a lazy-CJS factory on `window.__ModuleLoader__`. The
 * tests therefore install that facade, evaluate the file, and materialise the
 * factory exactly as the shell would — which also proves the bundle is shaped
 * the way the shell requires.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import vm from 'node:vm'

const CLIENT = fileURLToPath(new URL('../lib/client.cjs.js', import.meta.url))

/** The factory the bundle registered, once it has been evaluated. */
let registered
/** The bundle's exports, materialised through a stand-in `require`. */
let client

/** Handles the suite drives, bound once the bundle has been materialised. */
let parseNames, formatNames, writeAndVerify, COPY

/** React stand-in: enough for the module body, which only calls `useState`. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (factory) => factory(),
  useEffect: () => {},
}

before(async () => {
  const source = await readFile(CLIENT, 'utf8')
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { registered = definition } } },
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.cjs.js' })
  assert.ok(registered, 'the bundle did not register a module factory')
  client = registered.factory((specifier) => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected require: ${specifier}`)
  })
  ;({ parseNames, formatNames, writeAndVerify, COPY } = client)
})

describe('the client bundle', () => {
  it('registers under the plugin name', () => {
    assert.equal(registered.id, 'dsh-at-file-everything')
    assert.equal(client.name, 'dsh-at-file-everything')
  })

  it('gates only on services both settings lines provide', () => {
    // `configForms` is probed, not injected: a hard inject on a service an older
    // line lacks would keep `apply` from running at all.
    assert.deepEqual([...client.inject], ['slots', 'locale'])
  })

  it('exports the card and the helpers the tests drive', () => {
    assert.equal(typeof client.apply, 'function')
    assert.equal(typeof client.EverythingCard, 'function')
    assert.equal(typeof client.parseNames, 'function')
    assert.equal(typeof client.writeAndVerify, 'function')
  })

  it('does not require the primitives package, so it mounts without CSS', () => {
    // The module body must not reach for it: `require` here throws on anything
    // but `react`, and materialising the factory already succeeded.
    assert.ok(client)
  })

  it('tries the patch entry id first, because that is what keyed the form', () => {
    // `SettingsForms.describe()` keys a form by the Loader entry id, and this
    // bundle's own patch declares `file-reference-everything`. Assuming the
    // package name would leave the card bound to nothing.
    assert.equal(client.SETTINGS_NAMESPACE_CANDIDATES[0], 'file-reference-everything')
    assert.ok(client.SETTINGS_NAMESPACE_CANDIDATES.includes('dsh-at-file-everything'))
  })
})

describe('apply', () => {
  /** A fake client context recording slot registrations. */
  function fakeContext({ withForms = true } = {}) {
    const slots = []
    const scopes = new Map()
    const ctx = {
      slots: {
        inject: (_name, factory) => factory(),
        register: (options, component) => {
          slots.push({ options, component })
          return () => {}
        },
      },
      effect: (callback) => {
        callback()
      },
      locale: { bind: () => COPY_EN() },
      get: (service) =>
        service === 'configForms' && withForms
          ? {
              get: (namespace) => {
                if (!scopes.has(namespace)) {
                  throw new Error(`unknown namespace ${namespace}`)
                }
                return scopes.get(namespace)
              },
            }
          : undefined,
    }
    return { ctx, slots, scopes }
  }

  // Read lazily: the suite body is evaluated before `before` materialises the
  // bundle, so touching `client` here would be a temporal-dead-zone read.
  const COPY_EN = () => client.COPY.en

  it('registers both configuration slots', () => {
    const { ctx, slots } = fakeContext()
    client.apply(ctx)
    assert.deepEqual(
      slots.map((entry) => entry.options.name).sort(),
      ['plugins.bundle.config', 'plugins.row.config'],
    )
  })

  it('keys the bundle slot by package name and the row slot by package#row', () => {
    // The Plugins page compares these against its own inventory name, which is
    // not the settings namespace.
    const { ctx, slots } = fakeContext()
    client.apply(ctx)
    const byName = new Map(slots.map((entry) => [entry.options.name, entry.options.key]))
    assert.equal(byName.get('plugins.bundle.config'), 'dsh-at-file-everything')
    assert.equal(byName.get('plugins.row.config'), 'dsh-at-file-everything#file-reference-everything')
  })

  it('binds the scope the Host actually serves, not a guessed name', () => {
    const { ctx, slots, scopes } = fakeContext()
    const served = { status: 'ready', writable: true, value: {}, subscribe: () => () => {} }
    scopes.set('file-reference-everything', served)
    client.apply(ctx)
    const face = slots[0].options.inject()
    assert.equal(face.settingsScope, served)
  })

  it('leaves the scope unbound when no namespace is served', () => {
    const { ctx, slots } = fakeContext()
    client.apply(ctx)
    assert.equal(slots[0].options.inject().settingsScope, undefined)
  })

  it('still registers the card when the settings service is absent', () => {
    // The card renders its own "unavailable" notice, which is more useful than a
    // page that silently shows no custom card at all — and that silent fallback is
    // exactly what let the Host draw a generic schema form instead.
    const { ctx, slots } = fakeContext({ withForms: false })
    client.apply(ctx)
    assert.equal(slots.length, 2)
    assert.equal(slots[0].options.inject().settingsScope, undefined)
  })

  it('registers the card even when the locale binding fails', () => {
    // A throw here would abort `apply` before any card existed.
    const { ctx, slots } = fakeContext()
    ctx.locale = { register: () => {}, bind: () => { throw new Error('unknown namespace') } }
    client.apply(ctx)
    assert.equal(slots.length, 2)
  })

  it('survives one slot failing without losing the other', () => {
    const { ctx, slots } = fakeContext()
    const realInject = ctx.slots.inject
    let calls = 0
    ctx.slots.inject = (name, factory) => {
      calls += 1
      if (calls === 1) throw new Error('slot not declared')
      return realInject(name, factory)
    }
    client.apply(ctx)
    assert.equal(slots.length, 1)
  })
})

describe('the card', () => {
  it('renders the unavailable notice without a settings scope', () => {
    const tree = client.EverythingCard({ settingsScope: undefined })
    const text = JSON.stringify(tree)
    assert.match(text, /unavailable|未加载|配置/)
  })

  it('renders two lists from the stored values', () => {
    const scope = {
      status: 'ready',
      writable: true,
      value: { excludeInQuery: ['Library'], excludedDirectories: ['obj', 'Logs'] },
      getSnapshot: () => ({ status: 'ready', writable: true, value: { excludeInQuery: ['Library'], excludedDirectories: ['obj', 'Logs'] } }),
      subscribe: () => () => {},
      set: () => Promise.resolve(true),
    }
    const text = JSON.stringify(client.EverythingCard({ settingsScope: scope }))
    assert.match(text, /Library/)
    assert.match(text, /obj/)
  })
})

/**
 * Compare a list produced inside the `vm` realm with one from this realm.
 *
 * `assert.deepEqual` is not usable across realms: the value's `Array.prototype`
 * is the sandbox's, so two structurally identical arrays are "not reference-equal".
 * Copying into a plain array of primitives before comparing keeps the assertion
 * about the values rather than about which realm built them.
 *
 * @param actual - the value returned from the sandbox.
 * @param expected - the same value from this realm.
 */
function sameStringList(actual, expected) {
  assert.ok(Array.isArray(actual), `expected an array, got ${typeof actual}`)
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index], expected[index], `index ${String(index)}`)
  }
}

/** Assert one value is `undefined`, across realms. */
function isUndefined(value) {
  assert.equal(value, undefined)
}

describe('copy resolution', () => {
  it('always returns a complete table, so no caption can be undefined', () => {
    // The regression this exists for: `ctx.locale.bind()` returns a lookup
    // FUNCTION, and treating it as a copy table left every label, hint and button
    // caption undefined while data-driven inputs still showed their values — a
    // card of empty boxes. Pin that every field is a usable string.
    for (const language of ['zh', 'en']) {
      const copy = client.copyFor(language)
      for (const [field, value] of Object.entries(copy)) {
        // `sourceLabels` is the one nested table; it is checked separately below.
        if (field === 'sourceLabels') continue
        assert.equal(typeof value, 'string', `${language}.${field} is ${typeof value}`)
        assert.ok(value.length > 0, `${language}.${field} is empty`)
      }
      for (const [field, value] of Object.entries(copy.sourceLabels)) {
        assert.equal(typeof value, 'string', `${language}.sourceLabels.${field}`)
        assert.ok(value.length > 0, `${language}.sourceLabels.${field} is empty`)
      }
    }
  })

  it('picks the language from the locale service snapshot', () => {
    assert.equal(client.activeLanguage({ locale: { getSnapshot: () => ({ active: { id: 'zh-CN' } }) } }), 'zh')
    assert.equal(client.activeLanguage({ locale: { getSnapshot: () => ({ active: { id: 'en-US' } }) } }), 'en')
  })

  it('accepts a snapshot whose active locale is a bare string', () => {
    assert.equal(client.activeLanguage({ locale: { getSnapshot: () => ({ active: 'zh' }) } }), 'zh')
  })

  it('survives a locale service that throws or answers nonsense', () => {
    const throwing = { locale: { getSnapshot: () => { throw new Error('boom') } } }
    assert.ok(['zh', 'en'].includes(client.activeLanguage(throwing)))
    const nonsense = { locale: { getSnapshot: () => ({ active: 42 }) } }
    assert.ok(['zh', 'en'].includes(client.activeLanguage(nonsense)))
  })

  it('still answers when there is no locale service at all', () => {
    assert.ok(['zh', 'en'].includes(client.activeLanguage({})))
  })
})

describe('parseNames', () => {
  it('splits one name per line', () => {
    sameStringList(parseNames('Library\nOutput'), ['Library', 'Output'])
  })

  it('drops blank lines, so a trailing newline is not an error', () => {
    sameStringList(parseNames('Library\n\n  \nOutput\n'), ['Library', 'Output'])
  })

  it('trims surrounding whitespace from a pasted list', () => {
    sameStringList(parseNames('  Library  \r\n\tOutput\t'), ['Library', 'Output'])
  })

  it('answers an empty list for empty input', () => {
    sameStringList(parseNames(''), [])
  })

  it('accepts wildcards, which the user is invited to type', () => {
    sameStringList(parseNames('Lib*'), ['Lib*'])
    sameStringList(parseNames('Temp?'), ['Temp?'])
    sameStringList(parseNames('Library\nLib*\nOutput?'), ['Library', 'Lib*', 'Output?'])
  })

  it('rejects only the characters that would split the term', () => {
    // Everything builds the term from these, so a separator or an Everything
    // operator in one would change the query's meaning rather than name a folder.
    for (const bad of ['Li/brary', 'Li\\brary', 'a"b', 'a<b', 'a>b', 'a|b', 'a&b', 'a^b']) {
      isUndefined(parseNames(bad), `${bad} was accepted`)
    }
  })

  it('strips a leading exclamation mark instead of refusing it', () => {
    // The card tells the user not to type `!`, but someone pasting an Everything
    // query will. Accepting it is friendlier than rejecting the entry, and the
    // plugin adds its own marker anyway.
    sameStringList(parseNames('!Library'), ['Library'])
    sameStringList(parseNames('!Lib*'), ['Lib*'])
  })

  it('accepts names that merely look unusual', () => {
    sameStringList(parseNames('中文目录\n.NET\nmy dir'), ['中文目录', '.NET', 'my dir'])
  })
})

describe('parseFilePatterns', () => {
  it('accepts wildcards, which are the point of a pattern', () => {
    sameStringList(client.parseFilePatterns('*.meta\n*.pyc\n*.g.dart'), ['*.meta', '*.pyc', '*.g.dart'])
  })

  it('accepts a bare name too', () => {
    sameStringList(client.parseFilePatterns('Thumbs.db'), ['Thumbs.db'])
  })

  it('refuses a path separator, which would widen the term to a path test', () => {
    for (const bad of ['dir/*.meta', 'a\\b', 'a"b', 'a<b', 'a|b', 'a&b', 'a^b']) {
      isUndefined(client.parseFilePatterns(bad), `${bad} was accepted`)
    }
  })

  it('treats blank input as an empty list, not as an error', () => {
    // Clearing the control means "exclude nothing", which is a valid save.
    sameStringList(client.parseFilePatterns(''), [])
    sameStringList(client.parseFilePatterns('  \n\t\n'), [])
  })

  it('agrees with the folder parser, because the UI asks for one syntax', () => {
    // Both lists now take a bare name or pattern; only the label and the query
    // term differ, so the two parsers must not drift into separate dialects.
    for (const text of ['Library', 'Lib*', '*.meta', 'a?b']) {
      sameStringList(client.parseFilePatterns(text), parseNames(text))
    }
  })
})

describe('formatNames', () => {
  it('renders one name per line', () => {
    assert.equal(formatNames(['Library', 'Output']), 'Library\nOutput')
  })

  it('is empty for a missing or non-array value', () => {
    assert.equal(formatNames(undefined), '')
    assert.equal(formatNames(null), '')
    assert.equal(formatNames('Library'), '')
  })

  it('ignores non-string entries rather than printing them', () => {
    assert.equal(formatNames(['Library', 7, null]), 'Library')
  })
})

/** A scope whose read-back is exactly what was written. */
function honestScope(initial) {
  const start = initial ?? {}
  const state = { value: { ...start }, writable: true, status: 'ready' }
  return {
    getSnapshot: () => ({ ...state, value: { ...state.value } }),
    subscribe: () => () => {},
    set: (field, value) => {
      state.value[field] = value
      return Promise.resolve(true)
    },
  }
}

/** A scope that answers `set` successfully but stores nothing. */
function silentScope(initial) {
  const start = initial ?? {}
  const state = { value: { ...start }, writable: true, status: 'ready' }
  return {
    getSnapshot: () => ({ ...state, value: { ...state.value } }),
    subscribe: () => () => {},
    set: () => Promise.resolve(true),
  }
}

describe('writeAndVerify', () => {
  it('accepts a write that reads back', async () => {
    const scope = honestScope()
    await writeAndVerify(scope, 'excludeInQuery', ['Library'])
    sameStringList(scope.getSnapshot().value.excludeInQuery, ['Library'])
  })

  it('reports a write that resolved but did not persist', async () => {
    // The documented Windows failure: the atomic replace loses the race with a
    // scanner and the scope reloads and returns instead of failing.
    await assert.rejects(() => writeAndVerify(silentScope(), 'excludeInQuery', ['Library']), /did not persist/)
  })

  it('reports a write that persisted a different value', async () => {
    const scope = honestScope({ excludeInQuery: ['Old'] })
    scope.set = () => Promise.resolve(true)
    await assert.rejects(() => writeAndVerify(scope, 'excludeInQuery', ['Library']), /did not persist/)
  })

  it('propagates a rejected write', async () => {
    const scope = honestScope()
    scope.set = () => Promise.reject(new Error('read-only'))
    await assert.rejects(() => writeAndVerify(scope, 'excludeInQuery', []), /read-only/)
  })

  it('treats a reordered list as a real change', async () => {
    // A `set` that stores the new order must be accepted; the point is that
    // verification compares element by element rather than as a set, so an
    // order-only edit is not silently considered unchanged.
    const scope = honestScope({ excludeInQuery: ['Output', 'Library'] })
    await writeAndVerify(scope, 'excludeInQuery', ['Library', 'Output'])
    sameStringList(scope.getSnapshot().value.excludeInQuery, ['Library', 'Output'])
  })

  it('rejects a read-back whose order differs from what was written', async () => {
    const scope = honestScope({ excludeInQuery: ['Output', 'Library'] })
    // A scope that normalizes order would leave the stored value unlike the
    // request; that must surface rather than pass as a save.
    scope.set = () => Promise.resolve(true)
    await assert.rejects(
      () => writeAndVerify(scope, 'excludeInQuery', ['Library', 'Output']),
      /did not persist/,
    )
  })
})

describe('describeStatus', () => {
  // Read lazily: suite bodies are evaluated before `before` materialises the
  // bundle, so touching `client` here would be a temporal-dead-zone read.
  const copy = () => client.COPY.en

  /** The probe settled with this answer. */
  const ready = (status) => ({ status, failed: false, checking: false })

  it('stays quiet during the first probe, since the button already reports it', () => {
    assert.equal(client.describeStatus({ failed: false, checking: true }, copy()), '')
  })

  it('distinguishes "could not ask" from "nothing found"', () => {
    // These need opposite advice: one means install ES, the other means the route
    // did not answer. Reporting a transport failure as "not found" sent users to
    // install software they already had.
    const failed = client.describeStatus({ failed: true, checking: false }, copy())
    const empty = client.describeStatus(ready({ candidates: [], effective: undefined, overridden: false }), copy())
    assert.equal(failed, copy().probeFailed)
    assert.equal(empty, copy().notFound)
    assert.notEqual(failed, empty)
  })

  it('shows the detected path, which is the whole point of the line', () => {
    const text = client.describeStatus(
      ready({
        candidates: [{ path: 'C:\\apps\\es.exe', source: 'bundled' }],
        effective: 'C:\\apps\\es.exe',
        source: 'bundled',
        overridden: false,
      }),
      copy(),
    )
    assert.ok(text.includes('C:\\apps\\es.exe'), `the path is missing from ${text}`)
    assert.ok(text.includes(copy().sourceLabels.bundled), `no source label in ${text}`)
  })

  it('distinguishes a user install from the bundled fallback, which behave differently', () => {
    // "Your own client" and "the copy we shipped" are not interchangeable when
    // Everything is upgraded.
    const byPath = client.describeStatus(
      ready({ candidates: [], effective: 'C:\\es\\es.exe', source: 'path', overridden: false }),
      copy(),
    )
    const bundled = client.describeStatus(
      ready({ candidates: [], effective: 'C:\\es\\es.exe', source: 'bundled', overridden: false }),
      copy(),
    )
    assert.notEqual(byPath, bundled)
    assert.ok(byPath.includes(copy().sourceLabels.path))
    assert.ok(bundled.includes(copy().sourceLabels.bundled))
  })

  it('warns when a pinned path was not usable and a fallback answered', () => {
    // Otherwise the field would show one path while the line named another.
    const text = client.describeStatus(
      ready({
        candidates: [{ path: 'C:\\bundled\\es.exe', source: 'bundled' }],
        effective: 'C:\\bundled\\es.exe',
        source: 'bundled',
        overridden: true,
      }),
      copy(),
    )
    assert.ok(text.includes(copy().pinnedMissing), `no fallback warning in ${text}`)
  })

  it('does not warn when the pinned path itself answered', () => {
    const text = client.describeStatus(
      ready({
        candidates: [{ path: 'C:\\mine\\es.exe', source: 'configured' }],
        effective: 'C:\\mine\\es.exe',
        source: 'configured',
        overridden: true,
      }),
      copy(),
    )
    assert.ok(!text.includes(copy().pinnedMissing), `unexpected warning in ${text}`)
  })
})

describe('versionLine', () => {
  const copy = () => client.COPY.en

  it('shows the version the host reported', () => {
    const line = client.versionLine(
      { candidates: [], effective: 'C:\\es\\es.exe', source: 'path', version: '1.1.0.34', overridden: false },
      copy(),
    )
    assert.ok(line.includes('1.1.0.34'), line)
    assert.ok(line.includes(copy().versionLabel), line)
  })

  it('says nothing when the host could not read one', () => {
    // A client that will not print its version is a different problem from a missing
    // client; inventing a number here would hide it.
    assert.equal(client.versionLine({ candidates: [], effective: 'C:\\es\\es.exe', overridden: false }, copy()), undefined)
    assert.equal(client.versionLine(undefined, copy()), undefined)
    assert.equal(
      client.versionLine({ candidates: [], effective: 'C:\\a', version: '', overridden: false }, copy()),
      undefined,
    )
  })
})

describe('writeAndVerifyText', () => {
  it('accepts a string write that reads back', async () => {
    const scope = honestScope()
    await client.writeAndVerifyText(scope, 'esCommand', 'C:\\es\\es.exe')
    assert.equal(scope.getSnapshot().value.esCommand, 'C:\\es\\es.exe')
  })

  it('reports a string write that resolved but did not persist', async () => {
    await assert.rejects(
      () => client.writeAndVerifyText(silentScope(), 'esCommand', 'C:\\es\\es.exe'),
      /did not persist/,
    )
  })
})

describe('COPY', () => {
  it('carries both locales the harness ships', () => {
    assert.match(COPY.zh.save, /[\u4e00-\u9fa5]/)
    assert.doesNotMatch(COPY.en.save, /[\u4e00-\u9fa5]/)
  })

  it('explains the query-level modes, since they cost latency', () => {
    for (const locale of [COPY.zh, COPY.en]) {
      assert.match(locale.folderHint, /budget|candidate|配额/)
      assert.match(locale.fileHint, /\*\./)
      assert.ok(locale.rowsHint.length > 20)
    }
  })

  it('names both the folder and the file control', () => {
    // The two are separate fields because Everything parses a folder exclusion
    // differently from a file one; a card that showed one field for both would
    // write a folder pattern into a file term.
    for (const locale of [COPY.zh, COPY.en]) {
      assert.ok(locale.folderLabel.length >= 4, `folder label too short: ${locale.folderLabel}`)
      assert.ok(locale.fileLabel.length >= 4, `file label too short: ${locale.fileLabel}`)
      assert.notEqual(locale.folderLabel, locale.fileLabel)
    }
  })

  it('covers the path field, its placeholder and every detection source', () => {
    for (const locale of [COPY.zh, COPY.en]) {
      assert.ok(locale.pathLabel.length > 2)
      assert.ok(locale.pathHint.length > 20)
      assert.ok(locale.pathPlaceholder.length > 0)
      // Every source the resolver can report needs a label, or the status line
      // falls back to the raw tier name.
      for (const source of ['configured', 'path', 'bundled']) {
        assert.ok(locale.sourceLabels[source], `${source} has no label`)
      }
      assert.ok(locale.notFound.length > 10)
      assert.ok(locale.recheck.length > 0)
      assert.ok(locale.pinnedMissing.length > 10)
    }
  })
})
