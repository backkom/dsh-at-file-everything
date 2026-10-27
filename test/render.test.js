/**
 * Render the configuration card and assert on what a user would actually see.
 *
 * This exists because every earlier test asked a helper a question while the page
 * stayed broken. The card was registered, the slot key was right, the settings
 * scope resolved — and the page rendered a column of empty boxes, because
 * `ctx.locale.bind()` returns a lookup *function* and its result was being read as
 * a table of strings. Nothing in the suite looked at a rendered tree.
 *
 * So this expands the component the way React does and checks the captions. It is
 * coarse on purpose: if a label, a hint or a button caption goes missing again,
 * this fails regardless of which layer dropped it.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import vm from 'node:vm'

const BUNDLE = fileURLToPath(new URL('../lib/client.cjs.js', import.meta.url))

// Loaded at module scope, not in a `before` hook: `describe` bodies run before any
// hook, so a skip decision made from a hook would always say "not built".
let client
let loadError
try {
  const source = await readFile(BUNDLE, 'utf8')
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (definition) => { registered = definition } } }, console }
  vm.runInNewContext(source, sandbox, { filename: 'client.cjs.js' })
  client = registered.factory((specifier) => {
    if (specifier !== 'react') throw new Error(`unexpected require: ${specifier}`)
    return {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useMemo: (factory) => factory(),
      useEffect: () => {},
    }
  })
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error)
}

/** A settings scope shaped like `configForms.get(ns)` answers. */
const SCOPE = {
  getSnapshot: () => ({
    status: 'ready',
    writable: true,
    value: {
      esCommand: 'es.exe',
      excludeInQuery: ['Library'],
      excludeFilePatterns: ['*.meta'],
      excludedDirectories: ['.git', 'node_modules'],
    },
  }),
  subscribe: () => () => {},
  set: () => Promise.resolve(true),
}

/**
 * Run the browser half and capture what it registers.
 * @param options - which services exist and what locale the host reports.
 * @returns the registered slots.
 */
function register({ language = 'zh-CN', withForms = true } = {}) {
  const slots = []
  client.apply({
    locale: { getSnapshot: () => ({ active: { id: language } }) },
    get: (name) => (name === 'configForms' && withForms ? { get: () => SCOPE } : undefined),
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, component) => {
        slots.push({ options, component })
        return () => {}
      },
    },
    effect: (callback) => callback(),
  })
  return slots
}

/**
 * Expand an element tree, invoking function components as React would.
 * @param node - element, array, or primitive.
 * @returns the expanded node.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type({ ...(node.props ?? {}), children: node.children }))
  return { type: node.type, props: node.props ?? {}, children: (node.children ?? []).map(expand) }
}

/**
 * Collect every visible string in document order.
 * @param node - expanded node.
 * @param out - accumulator.
 * @returns the strings.
 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

/**
 * Render the first registered card.
 * @param options - see {@link register}.
 * @returns the visible strings and the rendered tree.
 */
function render(options) {
  const slots = register(options)
  assert.ok(slots.length > 0, 'the card registered no slot')
  const tree = expand(slots[0].component(slots[0].options.inject()))
  return { slots, tree, text: textOf(tree) }
}

describe('rendered configuration card', { skip: loadError === undefined ? false : `bundle not loadable: ${loadError}` }, () => {
  it('shows every caption a user needs to operate it', () => {
    // The regression: all of these were blank while the inputs kept their values.
    const { text } = render()
    for (const caption of ['es.exe 路径', '排除文件夹', '排除文件', '保存', '放弃修改']) {
      assert.ok(text.some((line) => line.includes(caption)), `missing caption: ${caption}\n${text.join('\n')}`)
    }
  })

  it('shows the hints that explain the exclusion trade-off', () => {
    const { text } = render()
    const hints = text.filter((line) => line.length > 40)
    assert.ok(hints.length >= 3, `expected the long hints, got:\n${text.join('\n')}`)
  })

  it('renders the stored values into its inputs', () => {
    const { tree } = render()
    const values = []
    const collect = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) collect(child)
        return
      }
      if (typeof node.props?.value === 'string') values.push(node.props.value)
      for (const child of node.children ?? []) collect(child)
    }
    collect(tree)
    assert.ok(values.includes('Library'), 'the folder list did not render')
    assert.ok(values.includes('*.meta'), 'the file list did not render')
    // The third list holds the values the profile actually has configured.
    assert.ok(values.some((value) => value.includes('.git')), 'the row list did not render')
  })

  it('speaks the language the host reports', () => {
    const english = render({ language: 'en-US' }).text
    assert.ok(english.some((line) => line.includes('es.exe path')), english.join('\n'))
    assert.ok(english.some((line) => line.includes('Save')), english.join('\n'))
    assert.ok(!english.some((line) => line.includes('保存')), 'Chinese copy leaked into the English card')
  })

  it('still renders its captions when the settings service is absent', () => {
    // The card degrades to a notice, but it must not render an empty shell.
    const { text } = render({ withForms: false })
    assert.ok(text.some((line) => line.length > 10), text.join('\n'))
  })

  it('gives every input a visible border and fill', () => {
    // The card once rendered with NO borders: it used a `--dsw-alias-*` name the
    // shipped themes do not define, and an unresolvable var() with no fallback
    // drops the whole declaration. Pin that the controls really carry a border,
    // and that every token has a fallback so one renamed alias cannot erase it.
    const { tree } = render()
    const controls = []
    const collect = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) collect(child)
        return
      }
      if (node.type === 'input' || node.type === 'textarea') controls.push(node.props.style ?? {})
      for (const child of node.children ?? []) collect(child)
    }
    collect(tree)
    assert.ok(controls.length >= 4, `expected the path field plus three lists, got ${String(controls.length)}`)
    for (const style of controls) {
      assert.match(String(style.border ?? ''), /solid/, `no border: ${JSON.stringify(style)}`)
      assert.ok(String(style.background ?? '').length > 0, `no fill: ${JSON.stringify(style)}`)
      for (const value of Object.values(style)) {
        if (typeof value !== 'string' || !value.includes('var(')) continue
        assert.match(value, /var\([^)]*,\s*[^)]+\)/, `token without a fallback: ${value}`)
      }
    }
  })

  it('registers both slots so either page surface finds it', () => {
    const { slots } = render()
    const names = slots.map((slot) => slot.options.name)
    assert.deepEqual(names, ['plugins.bundle.config', 'plugins.row.config'])
    assert.equal(slots[0].options.key, 'dsh-at-file-everything')
    assert.equal(slots[1].options.key, 'dsh-at-file-everything#file-reference-everything')
  })
})
