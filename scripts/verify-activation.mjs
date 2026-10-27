/**
 * Activate the *installed* copy exactly the way the host does.
 *
 * The activation error the user saw ("1 entry did not activate … maxResults must
 * be a positive safe integer") happens before any UI exists, so no amount of
 * unit testing over plain objects can catch it. This loads the profile's own
 * files, applies the real schema, and calls `apply`.
 *
 * Usage: node scripts/verify-activation.mjs [--profile <dir>]
 */

import { createRequire } from 'node:module'
import { register } from 'node:module'
import { existsSync } from 'node:fs'

const PROFILE = process.env.DSH_PROFILE_ROOT
  ?? `${process.env.USERPROFILE ?? 'C:/Users/Deqiang.li'}/.dsh/profiles/desktop`

/** Where this package's host half is loaded from. */
const TARGETS = [
  // The installed copy first: that is what the host actually runs.
  `${PROFILE}/node_modules/dsh-at-file-everything/lib/index.js`,
  // Otherwise the build in this checkout.
  new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
]
const target = TARGETS.find((path) => existsSync(path))
if (target === undefined) {
  console.error('no build found; run `npm run build` first')
  process.exit(1)
}

const requireFromProfile = createRequire(`${PROFILE}/package.json`)
const schemaEntry = requireFromProfile.resolve('@deepseek-ai/schemastery')

// Only the seams that need a running Harness are stubbed.
const frstub = `
export const FILE_REFERENCE_PROMPT = 'PROMPT'
export class FileReferenceService { constructor(ctx) { this.ctx = ctx } }
export default FileReferenceService
`
const toolstub = `
export function defineTool(o) {
  return { name: o.name, description: o.description, parameters: o.parameters,
           output: o.output, execute: o.execute }
}
`
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  const map = {
    '@deepseek-ai/dsh-file-reference': ${JSON.stringify(frstub)},
    '@deepseek-ai/dsh-tools': ${JSON.stringify(toolstub)},
  }
  if (map[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(map[spec]), shortCircuit: true }
  if (spec === '@deepseek-ai/schemastery') {
    return { url: 'file:///' + ${JSON.stringify(schemaEntry.replaceAll('\\', '/'))}, shortCircuit: true }
  }
  return next(spec, ctx)
}`)) 

console.log('loading:', target)
const { apply, Config } = await import(`file:///${target.replaceAll('\\', '/')}`)

// Apply the schema the way the Loader does; every field becomes a handle.
const config = Config({})
const isHandle = (value) => typeof value?.get === 'function'
console.log('maxResults is a volatile handle:', isHandle(config.maxResults))
// This is exactly what the pre-fix validation did, and why it rejected a valid
// configuration: the handle is an object, not the number 20.
console.log('Number.isSafeInteger(config.maxResults):', Number.isSafeInteger(config.maxResults))

const registered = []
let failure
const policies = []
try {
  apply(
    {
      agents: { list: () => [] },
      workingDirectory: { ensure: async () => 'C:\\work' },
      logger: { info: (m) => console.log('  info:', m), warn: (m) => console.log('  warn:', m) },
      on: () => {},
      effect: () => {},
      fiber: { id: 'verify' },
      inject: (names, callback) => {
        // A Cordis gate is hard: the callback runs only when EVERY named service
        // is present, and runs again if one appears later. Model that here, or the
        // script would report "no tools" for a host that provides them.
        const scope = {
          effect: (factory) => {
            factory()
          },
          settings: {
            configure: (presentation, owner) => {
              policies.push({ presentation, owner })
              return () => {}
            },
          },
          tools: {
            register: (definition) => {
              registered.push(definition)
              return () => {}
            },
          },
          webServer: { register: () => () => {} },
        }
        if (!names.every((name) => name in scope)) return undefined
        callback(scope)
        return undefined
      },
    },
    config,
  )
} catch (error) {
  failure = error
}

if (failure !== undefined) {
  console.error('\nACTIVATION FAILED:', failure.message)
  process.exitCode = 1
} else {
  console.log('\nACTIVATION: ok')
  console.log('tools registered:', registered.map((tool) => tool.name).join(', ') || '(none)')
  const policy = policies[0]
  console.log(
    'configuration page policy:',
    policy === undefined
      ? 'NOT CLAIMED — the Host will draw a generic form instead of the card'
      : `auto=${String(policy.presentation.auto)}`,
  )
  if (policy === undefined) process.exitCode = 1
}
