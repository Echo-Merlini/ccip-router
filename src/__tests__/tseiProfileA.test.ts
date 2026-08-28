import { readFile } from 'node:fs/promises'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { SQLiteDB } from '../db/sqlite.js'
import { recoverRecordSigner, verifyRecord } from '../crypto/sign.js'
import {
  inspectTseiPublicReceipt,
  makeUnsignedTseiProfileAObservation,
  signTseiProfileAObservation,
  toTseiProfileAAttestation,
  TSEI_PROFILE_A_NAMESPACE,
  TSEI_PROFILE_A_VANTAGE_CLASS,
} from '../integrations/tseiProfileA.js'

// Hardhat dev key 0 — public and safe for tests only.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`
const TIMESTAMP = 1_787_584_157
const RECEIPT_SHA = '0x09349e8257da2b94227f7af7f8e4dcdcca9e715dc460e1f419e53a14a22e5a07'
const INSTANCE_INPUT_HASH = '0xb17a5a2503494b793cc9ac5e7eaa6ff9dd5833c89af4e622005b4ede2d4c32c5'

const fixtureUrl = new URL(
  '../../conformance/tsei-profile-a-v0/fixtures/tsei-ia-real-v2-20260824-02.production-grounding.json',
  import.meta.url,
)

async function fixture(): Promise<Uint8Array> {
  return readFile(fixtureUrl)
}

function replaceUtf8(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const text = new TextDecoder().decode(bytes)
  assert.ok(text.includes(from), `fixture must contain ${from}`)
  return new TextEncoder().encode(text.replace(from, to))
}

describe('TSEI → Profile A observation mapping', () => {
  test('pins the exact public receipt and deterministic observation identity', async () => {
    const bytes = await fixture()
    const inspected = inspectTseiPublicReceipt(bytes)
    const record = makeUnsignedTseiProfileAObservation(bytes, TIMESTAMP)

    assert.equal(bytes.byteLength, 3841)
    assert.equal(inspected.instanceId, 'tsei-ia-real-v2-20260824-02')
    assert.equal(inspected.receiptSha256, RECEIPT_SHA)
    assert.equal(record.inputHash, INSTANCE_INPUT_HASH)
    assert.equal(record.namespace, TSEI_PROFILE_A_NAMESPACE)
    assert.equal(record.key, record.inputHash)
    assert.equal(record.value, RECEIPT_SHA)
    assert.equal(record.signature, '0x', 'unsigned preimage must never gain signer weight')
  })

  test('signs through the existing ccip-router path and verifies independently', async () => {
    const record = await signTseiProfileAObservation(await fixture(), TIMESTAMP, KEY)
    const attestation = await toTseiProfileAAttestation(record)

    assert.match(record.signature, /^0x[0-9a-f]{130}$/)
    assert.equal((await recoverRecordSigner(record)).toLowerCase(), ADDRESS.toLowerCase())
    assert.equal(await verifyRecord(record, ADDRESS), true)
    assert.equal(attestation.input_hash, record.inputHash)
    assert.equal(attestation.value, RECEIPT_SHA)
    assert.equal(attestation.signer.toLowerCase(), ADDRESS.toLowerCase())
    assert.equal(attestation.vantage_class, TSEI_PROFILE_A_VANTAGE_CLASS)
    assert.equal('source_peer' in attestation, false, 'transport metadata must not become authority')
  })

  test('refuses to convert an unsigned observation into Profile A signer weight', async () => {
    const unsigned = makeUnsignedTseiProfileAObservation(await fixture(), TIMESTAMP)
    await assert.rejects(() => toTseiProfileAAttestation(unsigned), /65-byte signature/)
  })

  test('same instance plus different exact receipt bytes surfaces divergence', async () => {
    const original = await fixture()
    const changed = replaceUtf8(
      original,
      'PRODUCTION_GROUNDING_MINTED_REAL_RUN_NOT_CLAIMED',
      'PRODUCTION_GROUNDING_REPORTED_REAL_RUN_NOT_CLAIMED',
    )
    const first = await signTseiProfileAObservation(original, TIMESTAMP, KEY)
    const second = await signTseiProfileAObservation(changed, TIMESTAMP + 1, KEY)

    assert.equal(second.inputHash, first.inputHash, 'instance identity must remain comparable')
    assert.notEqual(second.value, first.value, 'different exact receipt bytes must remain visible')

    const db = new SQLiteDB(':memory:')
    try {
      await db.insertRecord(first)
      await db.insertRecord(second)
      const state = await db.getRecordState(first.inputHash, first.namespace)
      assert.equal(state.state, 'divergent')
      if (state.state === 'divergent') assert.equal(state.records.length, 2)
    } finally {
      db.close()
    }
  })

  test('same exact receipt signed twice stays one observation and retains two attestations', async () => {
    const bytes = await fixture()
    const first = await signTseiProfileAObservation(bytes, TIMESTAMP, KEY)
    const second = await signTseiProfileAObservation(bytes, TIMESTAMP + 1, KEY)

    const db = new SQLiteDB(':memory:')
    try {
      await db.insertRecord(first)
      await db.insertRecord(second)
      const state = await db.getRecordState(first.inputHash, first.namespace)
      assert.equal(state.state, 'single')
      const attestations = await db.getSignedAttestations(first.inputHash, first.namespace, first.value)
      assert.equal(attestations.length, 2)
    } finally {
      db.close()
    }
  })

  test('different TSEI instance gets a different observation identity', async () => {
    const original = await fixture()
    const changed = replaceUtf8(
      original,
      'tsei-ia-real-v2-20260824-02',
      'tsei-ia-real-v2-20260824-03',
    )
    const first = makeUnsignedTseiProfileAObservation(original, TIMESTAMP)
    const second = makeUnsignedTseiProfileAObservation(changed, TIMESTAMP)
    assert.notEqual(second.inputHash, first.inputHash)
  })

  test('rejects wrong schema, malformed UTF-8, and invalid timestamp fail-closed', async () => {
    const bytes = await fixture()
    const wrongSchema = replaceUtf8(
      bytes,
      'tsei-v2-public-production-grounding-receipt.v1',
      'tsei-v2-public-production-grounding-receipt.v0',
    )
    assert.throws(() => inspectTseiPublicReceipt(wrongSchema), /unsupported TSEI public-receipt schema/)
    assert.throws(() => inspectTseiPublicReceipt(Uint8Array.from([0xc3, 0x28])), /valid UTF-8/)
    assert.throws(() => makeUnsignedTseiProfileAObservation(bytes, -1), /timestamp/)
    assert.throws(() => makeUnsignedTseiProfileAObservation(bytes, 1.5), /timestamp/)
  })

  test('does not normalize a byte-only representation change', async () => {
    const bytes = await fixture()
    const withoutFinalLf = bytes.slice(0, -1)
    const canonical = makeUnsignedTseiProfileAObservation(bytes, TIMESTAMP)
    const changed = makeUnsignedTseiProfileAObservation(withoutFinalLf, TIMESTAMP)

    assert.equal(changed.inputHash, canonical.inputHash)
    assert.notEqual(changed.value, canonical.value)
  })
})
