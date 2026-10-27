/**
 * Tests for configuration handling with `volatile` fields.
 *
 * Every field of this plugin's Config is `volatile`, and the Loader therefore
 * hands `apply` a frozen `{ get }` handle per field rather than a value. A build
 * that read those fields directly validated a handle as if it were a number,
 * rejected a perfectly good configuration, and left the whole bundle inactive —
 * which is invisible to any test that passes plain objects. These tests pass the
 * real handle shape for exactly that reason.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { currentValue, normalizeConfig } from '../lib/config.js'

/**
 * Build a handle shaped like the Loader's `createVolatile`.
 * @param value - the current value.
 * @returns a frozen object whose `get()` returns it.
 */
function handle(value) {
  return Object.freeze({ get: () => value })
}

/** A configuration with every field wrapped in a volatile handle. */
function volatileConfig(overrides = {}) {
  return {
    esCommand: handle('es.exe'),
    maxResults: handle(20),
    maxCandidates: handle(300),
    timeoutMs: handle(10000),
    deadlineMs: handle(25000),
    excludedDirectories: handle([]),
    excludeInQuery: handle([]),
    excludeFilePatterns: handle([]),
    fuzzyFallback: handle(true),
    extraPathDirectories: handle([]),
    installPrompt: handle(true),
    ...overrides,
  }
}

describe('currentValue', () => {
  it('unwraps a volatile handle', () => {
    assert.equal(currentValue(handle(20)), 20)
    assert.deepEqual(currentValue(handle(['a'])), ['a'])
  })

  it('exists because a handle is an object, not the value it carries', () => {
    // This is the exact shape of the activation failure: the Loader's handle is
    // an object, so a naive `Number.isSafeInteger` check rejects a valid config
    // and the whole bundle fails to load.
    const wrapped = handle(20)
    assert.equal(Number.isSafeInteger(wrapped), false)
    assert.equal(Number.isSafeInteger(currentValue(wrapped)), true)
  })

  it('passes a plain value through', () => {
    assert.equal(currentValue(20), 20)
    assert.equal(currentValue('es.exe'), 'es.exe')
    assert.equal(currentValue(undefined), undefined)
    assert.equal(currentValue(null), null)
  })

  it('does not mistake a plain object for a handle', () => {
    const plain = { maxResults: 20 }
    assert.equal(currentValue(plain), plain)
  })
})

describe('normalizeConfig with volatile fields', () => {
  it('accepts a fully volatile configuration, which is what the Loader passes', () => {
    // The regression this file exists for: this call used to throw
    // "maxResults must be a positive safe integer".
    assert.doesNotThrow(() => normalizeConfig(volatileConfig()))
  })

  it('keeps the handles, so a later card edit still reaches the provider', () => {
    // Unwrapping into a plain copy here would pin the first value forever and
    // silently make the whole `volatile` config read-only.
    const config = volatileConfig()
    const normalized = normalizeConfig(config)
    assert.equal(typeof normalized.maxResults.get, 'function')
    assert.equal(normalized.maxResults, config.maxResults)
  })

  it('still rejects a genuinely bad number', () => {
    assert.throws(
      () => normalizeConfig(volatileConfig({ maxResults: handle(0) })),
      /maxResults must be a positive safe integer/,
    )
    assert.throws(
      () => normalizeConfig(volatileConfig({ maxCandidates: handle(-1) })),
      /maxCandidates must be a positive safe integer/,
    )
  })

  it('reports the type it saw, so a handle-shaped bug is diagnosable', () => {
    // If someone reintroduces a read that bypasses the unwrapping, the message
    // should say "object" rather than repeating the field name.
    assert.throws(
      () => normalizeConfig(volatileConfig({ maxResults: { wrong: 'shape' } })),
      /got object/,
    )
  })

  it('validates the exclusion patterns through the handle', () => {
    assert.doesNotThrow(() => normalizeConfig(volatileConfig({ excludeInQuery: handle(['Lib*']) })))
    assert.throws(
      () => normalizeConfig(volatileConfig({ excludeInQuery: handle(['a/b']) })),
      /folder-name patterns/,
    )
  })

  it('rejects a deadline that does not exceed the timeout', () => {
    assert.throws(
      () => normalizeConfig(volatileConfig({ timeoutMs: handle(30000), deadlineMs: handle(30000) })),
      /deadlineMs must exceed timeoutMs/,
    )
  })

  it('fills in a field the caller omitted', () => {
    const partial = volatileConfig()
    delete partial.maxResults
    const normalized = normalizeConfig(partial)
    assert.equal(currentValue(normalized.maxResults), 20)
  })

  it('accepts a plain object, which is what a test or a direct apply passes', () => {
    const plain = {
      esCommand: 'es.exe',
      maxResults: 20,
      maxCandidates: 300,
      timeoutMs: 10000,
      deadlineMs: 25000,
      excludedDirectories: [],
      excludeInQuery: ['Lib*'],
      excludeFilePatterns: ['*.meta'],
      fuzzyFallback: true,
      extraPathDirectories: [],
      installPrompt: true,
    }
    const normalized = normalizeConfig(plain)
    assert.equal(normalized.maxResults, 20)
    assert.deepEqual(normalized.excludeInQuery, ['Lib*'])
  })

  it('rejects an empty esCommand through the handle', () => {
    assert.throws(
      () => normalizeConfig(volatileConfig({ esCommand: handle('  ') })),
      /esCommand must not be empty/,
    )
  })
})
