/**
 * Serve the status route on a real HTTP server and fetch it like the card does.
 *
 * The card's readout depends on this route answering over HTTP, and every earlier
 * check stopped at calling the handler by hand. This starts an actual server,
 * registers the route through `apply`, and fetches it with `fetch` — the same path
 * the browser takes.
 */

import { createServer } from 'node:http'
import { register } from 'node:module'

const zstub = `
const mk = () => { const f = (...a) => mk(); f.default = () => mk(); f.step = () => mk(); f.min = () => mk()
  f.max = () => mk(); f.description = () => mk(); f.volatile = () => mk(); return f }
export default { string: mk, number: mk, boolean: mk, array: mk, object: mk }
`
const frstub = `
export const FILE_REFERENCE_PROMPT = 'P'
export class FileReferenceService { constructor(ctx) { this.ctx = ctx } }
export default FileReferenceService
`
const toolstub = `
export function defineTool(o) { return { name: o.name, output: o.output, execute: o.execute } }
`
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  const map = {
    '@deepseek-ai/schemastery': ${JSON.stringify(zstub)},
    '@deepseek-ai/dsh-file-reference': ${JSON.stringify(frstub)},
    '@deepseek-ai/dsh-tools': ${JSON.stringify(toolstub)},
  }
  if (map[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(map[spec]), shortCircuit: true }
  return next(spec, ctx)
}`))

const { apply, Config, STATUS_ROUTE } = await import('../lib/index.js')

/** Route table the fake webServer fills, mirroring the Host's own. */
const routes = new Map()
const server = createServer((req, res) => {
  const handler = routes.get(req.url)
  if (handler === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

apply(
  {
    agents: { list: () => [] },
    workingDirectory: { ensure: async () => 'C:\\work' },
    logger: { info() {}, warn() {} },
    on: () => {},
    effect: (factory) => factory(),
    fiber: { id: 'verify' },
    inject: (names, callback) => {
      const scope = {
        effect: (factory) => factory(),
        settings: { configure: () => () => {} },
        tools: { register: () => () => {} },
        webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
      }
      if (!names.every((name) => name in scope)) return undefined
      callback(scope)
      return undefined
    },
  },
  Config({}),
)

console.log('routes registered:', [...routes.keys()])

const response = await fetch(`http://127.0.0.1:${port}${STATUS_ROUTE}`, {
  headers: { accept: 'application/json' },
})
console.log('HTTP status:', response.status, '| content-type:', response.headers.get('content-type'))
const body = await response.json()
console.log('effective:', body.effective)
console.log('source:', body.source)
console.log('version:', body.version ?? '(not reported)')
console.log('candidates:', body.candidates.map((candidate) => `${candidate.source}:${candidate.path}`).join('\n            '))

server.close()

if (body.effective === undefined) {
  console.log('\nRESULT: the route answers but found nothing — the card would say "not detected"')
  process.exitCode = 1
} else if (body.version === undefined) {
  console.log('\nRESULT: the path resolves but the version was not read — the card omits that line')
  process.exitCode = 1
} else {
  console.log('\nRESULT: the card will display the detected path and its version')
}
