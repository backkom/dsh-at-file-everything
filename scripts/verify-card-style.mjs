/**
 * Print the card's rendered text, plus which style tokens it references.
 *
 * Two questions only: does every caption render, and does every `var(--dsw-alias-…)`
 * name exist in the shipped themes? The second one matters because an unresolvable
 * `var()` with no fallback invalidates the whole declaration — that is how this card
 * once lost every border.
 */

import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const ASAR = 'C:/Users/Deqiang.li/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const asar = (await readFile(ASAR)).toString('utf8', 0, 60_000_000)
const known = new Set([...asar.matchAll(/--dsw-alias-([a-zA-Z0-9-]+)/g)].map((m) => m[1]))

const source = await readFile('./lib/client.cjs.js', 'utf8')
let registered
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (d) => { registered = d } } }, console }, { filename: 'client.cjs.js' })
const client = registered.factory((specifier) => {
  if (specifier !== 'react') throw new Error(`unexpected require: ${specifier}`)
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (factory) => factory(),
    useEffect: () => {},
  }
})

const scope = {
  getSnapshot: () => ({
    status: 'ready',
    writable: true,
    value: { esCommand: 'es.exe', excludeInQuery: [], excludeFilePatterns: [], excludedDirectories: [] },
  }),
  subscribe: () => () => {},
  set: () => Promise.resolve(true),
}

const slots = []
client.apply({
  locale: { getSnapshot: () => ({ active: { id: 'zh-CN' } }) },
  get: (name) => (name === 'configForms' ? { get: () => scope } : undefined),
  slots: { inject: (_n, factory) => factory(), register: (options, component) => { slots.push({ options, component }); return () => {} } },
  effect: (callback) => callback(),
})

const expand = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type({ ...(node.props ?? {}), children: node.children }))
  return { type: node.type, props: node.props ?? {}, children: (node.children ?? []).map(expand) }
}

const tree = expand(slots[0].component(slots[0].options.inject()))

const text = []
const vars = new Set()

/** Collect `var(--dsw-alias-…)` names from any nested string in a style object. */
const scanStyle = (style) => {
  if (typeof style === 'string') {
    for (const m of style.matchAll(/var\(--dsw-alias-([a-zA-Z0-9-]+)/g)) vars.add(m[1])
    return
  }
  if (style === null || typeof style !== 'object') return
  for (const value of Object.values(style)) scanStyle(value)
}

const walk = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') {
    if (typeof node === 'string') text.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child)
    return
  }
  scanStyle(node.props?.style)
  for (const child of node.children ?? []) walk(child)
}
walk(tree)

console.log('--- visible text (empty exclusions) ---')
for (const line of text) console.log('  ' + line)

console.log('\n--- alias tokens referenced ---')
const missing = []
for (const name of [...vars].sort()) {
  const ok = known.has(name)
  if (!ok) missing.push(name)
  console.log(`  ${ok ? 'ok  ' : 'MISS'} --dsw-alias-${name}`)
}
console.log(missing.length === 0 ? '\nRESULT: all tokens exist' : `\nRESULT: unknown tokens — ${missing.join(', ')}`)
if (missing.length > 0) process.exitCode = 1
