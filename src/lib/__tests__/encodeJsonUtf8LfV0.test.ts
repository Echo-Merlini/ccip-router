import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { encodeJsonUtf8LfV0, gradeVector, DomainError } from '../encodeJsonUtf8LfV0.js'

const here = dirname(fileURLToPath(import.meta.url))
const VECTORS_PATH = join(here, 'encode-json-utf8-lf-v0.vectors.json')
// The immutable encode-json-utf8-lf.v0 vector digest (recompute-kit binding record for tsei.frozen-artifact).
const PINNED_VECTORS_SHA = '8d53ab1d3dfb2de1ba9db23ed06d6864b08b516451938a4b1f6db6bcdcf1950f'

test('vendored vectors match the immutable encode-json-utf8-lf.v0 digest', () => {
  const bytes = readFileSync(VECTORS_PATH)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PINNED_VECTORS_SHA)
})

test('qualification: 48/48 pinned .v0 vectors reproduce exactly', () => {
  const doc = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { vectors: Array<{ id: string; input: any; expect: unknown }> }
  assert.equal(doc.vectors.length, 48)
  for (const v of doc.vectors) {
    assert.deepEqual(gradeVector(v.input), v.expect, v.id)
  }
})

test('byte-identical to the previous naive encoder on real attestation inputs (identities unchanged)', () => {
  // the actual attestationIdentity preimage shape: all strings + one integer timestamp
  const real = {
    domain: 'ccip.attestation.unsigned.v1',
    input_hash: '0x09349e8257da2b94227f7af7f8e4dcdcca9e715dc460e1f419e53a14a22e5a07',
    namespace: 'tsei',
    key: 'k1',
    value: 'v1',
    timestamp: 1786000000,
  }
  const naive = (() => {
    const s: Record<string, unknown> = {}
    for (const k of Object.keys(real).sort()) s[k] = (real as Record<string, unknown>)[k]
    return JSON.stringify(s) + '\n'
  })()
  assert.equal(encodeJsonUtf8LfV0(real), naive)
  // strings carrying JSON-significant chars must also match JSON.stringify's escaping byte-for-byte
  const tricky = { a: 'has "quote" and \\ and \n and \t', b: 'ünïcodé ✓' }
  const naive2 = JSON.stringify({ a: tricky.a, b: tricky.b }) + '\n'
  assert.equal(encodeJsonUtf8LfV0(tricky), naive2)
})

test('fail-closed on the latent injectivity collisions (rejected, not silently mangled)', () => {
  const isDom = (cat: string) => (e: unknown) => e instanceof DomainError && e.category === cat
  assert.throws(() => encodeJsonUtf8LfV0({ v: Infinity }), isDom('NON_FINITE_NUMBER'))   // was -> {"v":null}, collided with null
  assert.throws(() => encodeJsonUtf8LfV0({ v: 9007199254740993 }), isDom('INTEGER_OUT_OF_RANGE')) // was -> 2^53, collided
  assert.throws(() => encodeJsonUtf8LfV0({ v: -0 }), isDom('NEGATIVE_ZERO'))              // was -> 0
  assert.throws(() => encodeJsonUtf8LfV0({ v: '\uD800' }), isDom('NON_SCALAR_STRING'))    // lone surrogate
})
