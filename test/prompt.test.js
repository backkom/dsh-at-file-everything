/**
 * Tests for the prompt sections this plugin contributes.
 *
 * The `find_files` guidance is the mechanism that makes the tool discoverable
 * without the user configuring anything, so it is the piece most worth pinning:
 * a regression here is invisible in the UI and shows up only as a model that
 * keeps walking the tree with `glob` instead of using the index.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { describe, it } from 'node:test'

// The Harness seams the bundle imports, stubbed so the suite runs anywhere.
const zstub = `
const mk = () => { const f = (...a) => mk(); f.default = () => mk(); f.step = () => mk(); f.min = () => mk()
  f.max = () => mk(); f.description = () => mk(); f.volatile = () => mk(); return f }
export default { string: mk, number: mk, boolean: mk, array: mk, object: mk }
`
const frstub = `
export const FILE_REFERENCE_PROMPT = 'REFERENCE-PROMPT'
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
    '@deepseek-ai/schemastery': ${JSON.stringify(zstub)},
    '@deepseek-ai/dsh-file-reference': ${JSON.stringify(frstub)},
    '@deepseek-ai/dsh-tools': ${JSON.stringify(toolstub)},
  }
  if (map[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(map[spec]), shortCircuit: true }
  return next(spec, ctx)
}`))

const { apply, FILE_SEARCH_PROMPT } = await import('../lib/index.js')

/** A complete config object, bypassing the schema stub. */
function config(overrides = {}) {
  return {
    esCommand: 'es.exe',
    maxResults: 20,
    maxCandidates: 300,
    timeoutMs: 10000,
    deadlineMs: 25000,
    excludedDirectories: [],
    excludeInQuery: [],
    excludeFilePatterns: [],
    fuzzyFallback: true,
    extraPathDirectories: [],
    installPrompt: true,
    ...overrides,
  }
}

/**
 * Run `apply` against a fake host and report what it registered.
 * @param options - config overrides and which services exist.
 * @returns the prompt sections by name, the page policies, and the tools.
 */
function install({
  overrides = {},
  canRead = true,
  withTools = true,
  withSettings = true,
  withWebServer = true,
} = {}) {
  const sections = []
  const policies = []
  const tools = []
  const agent = {
    ctx: {
      inject: (_names, callback) => {
        callback({
          systemPrompt: {
            getSectionOrder: (name) => ({ FILE_REFERENCE: 900, TOOL_GLOB: 1400 })[name],
            section: (options) => {
              sections.push(options)
              return { dispose: async () => {} }
            },
          },
          tools: { get: (name) => (name === 'read' && canRead ? {} : undefined) },
        })
        return { dispose: async () => {} }
      },
    },
  }
  apply(
    {
      agents: { list: () => [agent] },
      workingDirectory: { ensure: async () => 'C:\\work' },
      logger: { info() {}, warn() {} },
      on: () => {},
      effect: () => {},
      fiber: { id: 'test-fiber' },
      inject: (names, callback) => {
        // A Cordis gate is hard: the callback runs only when EVERY named service
        // is present. Model that, so a missing capability is observable here.
        const scope = {
          effect: (factory) => {
            factory()
          },
          ...(withSettings
            ? {
                settings: {
                  configure: (presentation, owner) => {
                    policies.push({ presentation, owner })
                    return () => {}
                  },
                },
              }
            : {}),
          ...(withTools
            ? {
                tools: {
                  register: (definition) => {
                    tools.push(definition)
                    return () => {}
                  },
                },
              }
            : {}),
          ...(withWebServer ? { webServer: { register: () => () => {} } } : {}),
        }
        if (!names.every((name) => name in scope)) return undefined
        callback(scope)
        return undefined
      },
    },
    config(overrides),
  )
  return { sections: new Map(sections.map((section) => [section.name, section])), policies, tools }
}

describe('the find_files guidance section', () => {
  it('is installed with no configuration at all', () => {
    // The user asked not to have to know the tool exists; that only holds if the
    // guidance is unconditional.
    const { sections } = install()
    assert.ok(sections.has('context:file-search'))
    assert.equal(sections.get('context:file-search').text(), FILE_SEARCH_PROMPT)
  })

  it('survives installPrompt: false, which governs only the @path section', () => {
    const { sections } = install({ overrides: { installPrompt: false } })
    assert.equal(sections.get('context:file-search')?.text(), FILE_SEARCH_PROMPT)
    assert.equal(sections.get('context:file-reference')?.text(), '')
  })

  it('survives an agent that cannot call read', () => {
    const { sections } = install({ canRead: false })
    assert.equal(sections.get('context:file-search')?.text(), FILE_SEARCH_PROMPT)
  })

  it('is absent when no tool was registered, so the model is never told about a call it cannot make', () => {
    const { sections } = install({ withTools: false })
    assert.ok(!sections.has('context:file-search') || sections.get('context:file-search').text() === '')
  })

  it('registers the tool through a gate, so a late tools service still gets it', () => {
    // Probed once with `ctx.get`, a Web server that provides `tools` after this
    // plugin loads would never see the tool — and the card's status route had the
    // same bug. Both are gated now.
    const { tools } = install()
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'find_files')
  })

  it('registers no tool when the composition has no tool registry', () => {
    const { tools } = install({ withTools: false })
    assert.equal(tools.length, 0)
  })

  it('sits immediately before the glob guidance, so the two read as one decision', () => {
    const { sections } = install()
    const search = sections.get('context:file-search')
    assert.equal(search.order, 1400 - 1)
  })

  it('says which question each tool answers', () => {
    // A tool description states what it does; this section states when to pick it
    // over the neighbours, which is the part the model gets wrong.
    assert.match(FILE_SEARCH_PROMPT, /find_files/)
    assert.match(FILE_SEARCH_PROMPT, /glob/)
    assert.match(FILE_SEARCH_PROMPT, /grep/)
    assert.match(FILE_SEARCH_PROMPT, /contents/i)
  })

  it('warns that a paged answer may be incomplete', () => {
    assert.match(FILE_SEARCH_PROMPT, /paged|truncat|limit/i)
  })

  it('explains path scoping, so the model does not assume a workspace confinement', () => {
    assert.match(FILE_SEARCH_PROMPT, /path/)
  })
})

describe('the @path reference section', () => {
  it('is offered when the agent can read', () => {
    assert.equal(install().sections.get('context:file-reference')?.text(), 'REFERENCE-PROMPT')
  })

  it('stays empty when the agent cannot read', () => {
    // Telling a model about `@path` it cannot open is noise.
    assert.equal(install({ canRead: false }).sections.get('context:file-reference')?.text(), '')
  })
})

describe('the configuration page policy', () => {
  it('is claimed for this instance, which is what suppresses the generic form', () => {
    // Without `configure({ auto: false })` the Host keeps `autoGenerate: true` and
    // draws a form from the Config schema; the browser half's card is then never
    // rendered. This is the fix for the blank configuration page, so it is pinned.
    const { policies } = install()
    assert.equal(policies.length, 1)
    assert.equal(policies[0].presentation.auto, false)
  })

  it('names this plugin fiber as the owner, so the policy is not applied to another instance', () => {
    const { policies } = install()
    assert.deepEqual(policies[0].owner, { id: 'test-fiber' })
  })

  it('is skipped when the deployment has no settings service', () => {
    const { policies } = install({ withSettings: false })
    assert.equal(policies.length, 0)
  })
})
