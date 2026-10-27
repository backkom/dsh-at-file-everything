/**
 * Static checks that the shipped client bundle is loadable by the Web shell.
 *
 * The shell evaluates `lib/client.cjs.js` as a classic script and expects it to
 * register a lazy-CJS factory; it does not import it as an ES module. A build
 * that emitted ESM, or inlined React, would fail at page boot with a console
 * error and a blank card, which no unit test of the module's logic would catch.
 * These checks pin the three properties the shell actually depends on.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import vm from 'node:vm'

const BUNDLE = fileURLToPath(new URL('../lib/client.cjs.js', import.meta.url))

/** Read the built bundle once. */
let source
try {
  source = await readFile(BUNDLE, 'utf8')
} catch {
  source = undefined
}

describe('shipped client bundle shape', { skip: source === undefined ? 'lib/client.cjs.js is not built' : false }, () => {
  it('registers through window.__ModuleLoader__ rather than exporting ESM', () => {
    assert.match(source, /window\.__ModuleLoader__\.load\(/)
    assert.doesNotMatch(source, /^\s*export\s+(default|function|const|class|\{)/m)
    assert.doesNotMatch(source, /^\s*import\s+.*from\s+['"]/m)
  })

  it('declares the id the shell keys the module graph by', () => {
    assert.match(source, /id:\s*['"]dsh-at-file-everything['"]/)
  })

  it('leaves react to the shell instead of bundling a second copy', () => {
    // A bundled React gives the card a different React instance than the page,
    // which breaks every hook it calls.
    assert.match(source, /require\("react"\)/)
    assert.doesNotMatch(source, /react\.development\.js/, 'a React build was inlined')
    assert.doesNotMatch(source, /process\.env\.NODE_ENV/, 'a development build leaked in')
  })

  it('never references process, which does not exist in the browser', () => {
    // The documented failure mode: an inlined dev build opens with
    // `process.env.NODE_ENV` and throws at module-evaluation time.
    assert.doesNotMatch(source, /typeof process|process\.env|process\.platform/)
  })

  it('does not touch node builtins', () => {
    for (const builtin of ['node:fs', 'node:path', 'node:child_process', 'node:os']) {
      assert.ok(!source.includes(`require("${builtin}")`), `${builtin} was required`)
    }
  })

  it('evaluates and materialises in a browser-shaped sandbox', () => {
    let registered
    const sandbox = {
      window: { __ModuleLoader__: { load: (definition) => { registered = definition } } },
      console,
    }
    assert.doesNotThrow(() => vm.runInNewContext(source, sandbox, { filename: 'client.cjs.js' }))

    // Only `react` may be asked for; anything else means the bundle reached for
    // a package the shell does not hand it.
    const asked = []
    const exported = registered.factory((specifier) => {
      asked.push(specifier)
      if (specifier === 'react') {
        return {
          createElement: () => ({}),
          useState: (initial) => [initial, () => {}],
          useMemo: (factory) => factory(),
          useEffect: () => {},
        }
      }
      throw new Error(`unexpected require: ${specifier}`)
    })
    assert.deepEqual(asked, ['react'])
    assert.equal(typeof exported.apply, 'function')
    assert.equal(typeof exported.EverythingCard, 'function')
  })
})
