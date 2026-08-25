import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SQLiteDB } from '../db/sqlite.js'
import type { MeshRecord } from '../db/types.js'

function makeDB() {
  return new SQLiteDB(':memory:')
}

function makeRecord(overrides: Partial<MeshRecord> = {}): MeshRecord {
  return {
    inputHash:  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    namespace:  'test-ns',
    key:        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    value:      '0xdeadbeef',
    timestamp:  1_700_000_000,
    signature:  '0x' + 'cc'.repeat(65),
    sourcePeer: null,
    ...overrides,
  }
}

describe('insertRecord + getRecord', () => {
  test('inserts and retrieves a record by inputHash', async () => {
    const db = makeDB()
    const rec = makeRecord()
    await db.insertRecord(rec)
    const found = await db.getRecord(rec.inputHash)
    assert.ok(found)
    assert.equal(found.inputHash, rec.inputHash)
    assert.equal(found.namespace, rec.namespace)
    db.close()
  })

  test('getRecord with namespace does exact-match lookup', async () => {
    const db = makeDB()
    await db.insertRecord(makeRecord({ namespace: 'ns-a' }))
    await db.insertRecord(makeRecord({ namespace: 'ns-b' }))

    const hash = makeRecord().inputHash
    const a = await db.getRecord(hash, 'ns-a')
    const b = await db.getRecord(hash, 'ns-b')
    assert.equal(a?.namespace, 'ns-a')
    assert.equal(b?.namespace, 'ns-b')
    db.close()
  })

  test('getRecord returns null for unknown hash', async () => {
    const db = makeDB()
    const result = await db.getRecord('0x' + '00'.repeat(32))
    assert.equal(result, null)
    db.close()
  })
})

describe('deduplication (INSERT OR IGNORE)', () => {
  test('same (inputHash, namespace) is inserted once', async () => {
    const db = makeDB()
    const rec = makeRecord()
    await db.insertRecord(rec)
    await db.insertRecord(rec)
    const count = await db.recordCount(rec.namespace)
    assert.equal(count, 1)
    db.close()
  })

  test('same inputHash with different namespace creates two records', async () => {
    const db = makeDB()
    await db.insertRecord(makeRecord({ namespace: 'ns-a' }))
    await db.insertRecord(makeRecord({ namespace: 'ns-b' }))
    const a = await db.recordCount('ns-a')
    const b = await db.recordCount('ns-b')
    assert.equal(a, 1)
    assert.equal(b, 1)
    db.close()
  })
})

describe('ERC-8309 divergence preservation', () => {
  // R-DUP: two OBSERVATION-IDENTICAL records (same (inputHash, namespace, value))
  // from different signers collapse to one — dedup is a correct no-op here.
  // Identity excludes signature/timestamp/peer. (Quorum profiles that count
  // per-value corroboration need the discarded multiplicity — a declared
  // extension, not mandated by this base; see the §Deduplication amendment note.)
  test('R-DUP: observation-identical records (same value) from different signers collapse to one', async () => {
    const db = makeDB()
    const rec = makeRecord({ value: '0xSAME', sourcePeer: 'nodeA' })
    await db.insertRecord(rec)
    await db.insertRecord({ ...rec, signature: '0x' + 'dd'.repeat(65), sourcePeer: 'nodeB' })
    const recs = await db.getRecordsByInputHash(rec.inputHash)
    assert.equal(recs.length, 1)
    assert.equal(recs[0].value, '0xSAME')
    db.close()
  })

  // R-DIV: two VALID observations with DIFFERENT value for the same key are BOTH
  // retained — the second is not silently dropped. This is the amendment; it was
  // RED before the PK widen (first-valid-wins) and is GREEN after.
  test('R-DIV: genuine divergence retains both observations, not one', async () => {
    const db = makeDB()
    const base = makeRecord({ value: '0xOUTPUT_A', sourcePeer: 'gatewayA' })
    await db.insertRecord(base)
    await db.insertRecord({ ...base, value: '0xOUTPUT_B', signature: '0x' + 'bb'.repeat(65), sourcePeer: 'gatewayB' })
    const recs = await db.getRecordsByInputHash(base.inputHash)
    assert.equal(recs.length, 2)
    assert.deepEqual(new Set(recs.map(r => r.value)), new Set(['0xOUTPUT_A', '0xOUTPUT_B']))
    db.close()
  })

  // Divergence is surfaced as a first-class state, never folded into agreement
  // and never a silently-chosen winner.
  test('getRecordState reports absent | single | divergent', async () => {
    const db = makeDB()
    const base = makeRecord({ value: '0xA' })
    const absent = await db.getRecordState(base.inputHash, base.namespace)
    assert.equal(absent.state, 'absent')

    await db.insertRecord(base)
    const single = await db.getRecordState(base.inputHash, base.namespace)
    assert.equal(single.state, 'single')

    await db.insertRecord({ ...base, value: '0xB', signature: '0x' + 'bb'.repeat(65), sourcePeer: 'nodeB' })
    const divergent = await db.getRecordState(base.inputHash, base.namespace)
    assert.equal(divergent.state, 'divergent')
    if (divergent.state === 'divergent') assert.equal(divergent.records.length, 2)
    db.close()
  })

  // Observation-identical collapse keeps the FIRST attestation (INSERT OR IGNORE),
  // not the last — locks the tie-break so it can't silently flip to keep-last.
  test('dedup keeps the first observation (first-valid-wins), not the last', async () => {
    const db = makeDB()
    const first = makeRecord({ value: '0xSAME', sourcePeer: 'nodeA' })
    await db.insertRecord(first)
    await db.insertRecord({ ...first, signature: '0x' + 'dd'.repeat(65), sourcePeer: 'nodeB' })
    const recs = await db.getRecordsByInputHash(first.inputHash)
    assert.equal(recs.length, 1)
    assert.equal(recs[0].sourcePeer, 'nodeA')  // REPLACE would surface nodeB
    db.close()
  })
})

// Equivocation (one signer, two signatures) is a distinct event from honest
// multi-vantage divergence (two signers). The detector must fire on the first
// and stay silent on the second — the base separates the two.
describe('double-sign detector (same-signer equivocation)', () => {
  function captureWarn(): { warns: string[]; restore: () => void } {
    const warns: string[] = []
    const orig = console.warn
    console.warn = ((m?: unknown) => { warns.push(String(m)) }) as typeof console.warn
    return { warns, restore: () => { console.warn = orig } }
  }

  test('warns when one signer submits a different signature for the same key', async () => {
    const db = makeDB()
    const c = captureWarn()
    try {
      const r = makeRecord({ sourcePeer: 'nodeA', signature: '0x' + 'aa'.repeat(65) })
      await db.insertRecord(r)
      await db.insertRecord({ ...r, value: '0xOTHER', signature: '0x' + 'bb'.repeat(65) })
    } finally { c.restore() }
    assert.ok(c.warns.some(w => w.includes('double-sign')), 'must warn on same-signer equivocation')
    db.close()
  })

  test('does NOT warn when different signers attest the same key (honest divergence)', async () => {
    const db = makeDB()
    const c = captureWarn()
    try {
      await db.insertRecord(makeRecord({ sourcePeer: 'nodeA', value: '0xA', signature: '0x' + 'aa'.repeat(65) }))
      await db.insertRecord(makeRecord({ sourcePeer: 'nodeB', value: '0xB', signature: '0x' + 'bb'.repeat(65) }))
    } finally { c.restore() }
    assert.equal(c.warns.filter(w => w.includes('double-sign')).length, 0, 'different signers is not equivocation')
    db.close()
  })
})

// The base extension: records keeps ONE observation per value (first-valid-wins), which discards
// per-value corroboration. A signature-keyed attestation table retains every distinct signed message
// without touching observation identity — quorum-class policies count these vantages.
describe('ERC-8309 attestation retention (signature-keyed)', () => {
  test('exact replay (same signature) is an idempotent no-op', async () => {
    const db = makeDB()
    const r = makeRecord({ value: '0xV', sourcePeer: 'nodeA', signature: '0x' + 'aa'.repeat(65) })
    await db.insertRecord(r)
    await db.insertRecord(r)   // byte-identical replay
    const atts = await db.getAttestations(r.inputHash, r.namespace, '0xV')
    assert.equal(atts.length, 1)
    db.close()
  })

  test('retains BOTH attestations of one value from different signers (corroboration records drops)', async () => {
    const db = makeDB()
    const base = makeRecord({ value: '0xV', sourcePeer: 'nodeA', signature: '0x' + 'aa'.repeat(65) })
    await db.insertRecord(base)
    await db.insertRecord({ ...base, sourcePeer: 'nodeB', signature: '0x' + 'bb'.repeat(65) })
    const recs = await db.getRecordsByInputHash(base.inputHash)
    assert.equal(recs.length, 1)                       // records collapses to one observation
    const atts = await db.getAttestations(base.inputHash, base.namespace, '0xV')
    assert.equal(atts.length, 2)                       // attestations keeps both signed messages
    assert.deepEqual(new Set(atts.map(a => a.sourcePeer)), new Set(['nodeA', 'nodeB']))
    db.close()
  })

  test('observation identity unchanged: same value, two signers is still single, not divergent', async () => {
    const db = makeDB()
    const base = makeRecord({ value: '0xV', signature: '0x' + 'aa'.repeat(65) })
    await db.insertRecord(base)
    await db.insertRecord({ ...base, sourcePeer: 'nodeB', signature: '0x' + 'bb'.repeat(65) })
    const st = await db.getRecordState(base.inputHash, base.namespace)
    assert.equal(st.state, 'single')                   // divergence is by distinct value, not attestation count
    db.close()
  })

  test('getAttestations is empty for an unattested value', async () => {
    const db = makeDB()
    await db.insertRecord(makeRecord({ value: '0xV' }))
    const atts = await db.getAttestations(makeRecord().inputHash, makeRecord().namespace, '0xOTHER')
    assert.equal(atts.length, 0)
    db.close()
  })

  // ECDSA malleability: (r, s, v) and (r, n-s, v') are the SAME signed message. Without low-s
  // canonicalization of the dedup key, one attestation stores as two (storage-growth / corroboration
  // inflation). They must collapse to one.
  test('malleated signatures (low-s vs high-s) collapse to one attestation', async () => {
    const db = makeDB()
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const r = 'ab'.repeat(32)
    const sLow = 0x1111111111111111111111111111111111111111111111111111111111111111n
    const hex = (x: bigint) => x.toString(16).padStart(64, '0')
    const sigLowS  = '0x' + r + hex(sLow)     + '1b'  // v=27, already low-s
    const sigHighS = '0x' + r + hex(N - sLow) + '1c'  // v=28, high-s malleation of the SAME signature
    const base = makeRecord({ value: '0xV', sourcePeer: 'nodeA', signature: sigHighS })
    await db.insertRecord(base)
    await db.insertRecord({ ...base, signature: sigLowS })
    const atts = await db.getAttestations(base.inputHash, base.namespace, '0xV')
    assert.equal(atts.length, 1)  // one signed message, not two
    db.close()
  })

  // Unsigned/dry-run records carry signature "0x". Keyed on the raw signature they would ALL collide
  // on "0x" and silently dedup away their own multiplicity. A content-digest fallback identity keeps
  // distinct unsigned records distinct.
  test('distinct unsigned records for one observation do NOT collapse on "0x"', async () => {
    const db = makeDB()
    const base = makeRecord({ value: '0xV', signature: '0x', sourcePeer: 'nodeA', timestamp: 100 })
    await db.insertRecord(base)
    await db.insertRecord({ ...base, timestamp: 200 })  // distinct observation content, same "0x"
    const atts = await db.getAttestations(base.inputHash, base.namespace, '0xV')
    assert.equal(atts.length, 2)
    db.close()
  })

  // Transport metadata (source_peer) is not part of identity — otherwise it could mint attestations.
  test('source_peer does not redefine unsigned identity (same observation, two peers = one)', async () => {
    const db = makeDB()
    const base = makeRecord({ value: '0xV', signature: '0x', sourcePeer: 'nodeA', timestamp: 100 })
    await db.insertRecord(base)
    await db.insertRecord({ ...base, sourcePeer: 'nodeB' })  // same content, different transport
    const atts = await db.getAttestations(base.inputHash, base.namespace, '0xV')
    assert.equal(atts.length, 1)
    db.close()
  })

  // Only signed attestations are eligible for V2 / quorum counting. "0x" stays observable, never counted.
  test('getSignedAttestations excludes unsigned "0x" records', async () => {
    const db = makeDB()
    const ih = '0x' + 'cd'.repeat(32)
    const signed = makeRecord({ inputHash: ih, value: '0xV', signature: '0x' + 'aa'.repeat(65), sourcePeer: 'nodeA' })
    await db.insertRecord(signed)
    await db.insertRecord({ ...signed, signature: '0x', sourcePeer: 'nodeB' })  // unsigned/dry-run
    const all = await db.getAttestations(ih, signed.namespace, '0xV')
    const eligible = await db.getSignedAttestations(ih, signed.namespace, '0xV')
    assert.equal(all.length, 2)       // both observable
    assert.equal(eligible.length, 1)  // only the signed one counts
    assert.notEqual(eligible[0].signature, '0x')
    db.close()
  })
})

describe('getRecordsByInputHash', () => {
  test('returns all records for a given inputHash across namespaces', async () => {
    const db = makeDB()
    await db.insertRecord(makeRecord({ namespace: 'ns-a' }))
    await db.insertRecord(makeRecord({ namespace: 'ns-b' }))
    await db.insertRecord(makeRecord({ namespace: 'ns-c' }))
    const recs = await db.getRecordsByInputHash(makeRecord().inputHash)
    assert.equal(recs.length, 3)
    db.close()
  })

  test('returns empty array for unknown hash', async () => {
    const db = makeDB()
    const recs = await db.getRecordsByInputHash('0x' + '00'.repeat(32))
    assert.deepEqual(recs, [])
    db.close()
  })
})

describe('getRecordsSince + cursor pagination', () => {
  test('returns records after a given timestamp', async () => {
    const db = makeDB()
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'aa'.repeat(32), timestamp: 1000 }))
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'bb'.repeat(32), timestamp: 2000 }))
    const recs = await db.getRecordsSince('test-ns', 1500, 100)
    assert.equal(recs.length, 1)
    assert.equal(recs[0].timestamp, 2000)
    db.close()
  })

  test('excludes a record at exactly `since` (strict >, not >=)', async () => {
    const db = makeDB()
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'aa'.repeat(32), timestamp: 1000 }))
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'bb'.repeat(32), timestamp: 2000 }))
    const recs = await db.getRecordsSince('test-ns', 1000, 100)  // since == first record's ts
    assert.equal(recs.length, 1)                                  // ts=1000 excluded by strict >
    assert.equal(recs[0].timestamp, 2000)
    db.close()
  })

  test('cursor skips already-seen records', async () => {
    const db = makeDB()
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'aa'.repeat(32), timestamp: 1000 }))
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'bb'.repeat(32), timestamp: 2000 }))

    const page1 = await db.getRecordsSince('test-ns', 0, 1)
    assert.equal(page1.length, 1)
    const cursor = `${page1[0].timestamp}|${page1[0].inputHash}`

    const page2 = await db.getRecordsSince('test-ns', 0, 1, cursor)
    assert.equal(page2.length, 1)
    assert.notEqual(page2[0].inputHash, page1[0].inputHash)
    db.close()
  })
})

describe('getContributions', () => {
  test('groups records by sourcePeer', async () => {
    const db = makeDB()
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'a1'.repeat(32), sourcePeer: 'http://peer-a' }))
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'a2'.repeat(32), sourcePeer: 'http://peer-a' }))
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'b1'.repeat(32), sourcePeer: 'http://peer-b' }))
    await db.insertRecord(makeRecord({ inputHash: '0x' + 'local'.repeat(12) + '00'.repeat(8), sourcePeer: null }))

    const contributions = await db.getContributions('test-ns')
    const byPeer = Object.fromEntries(contributions.map((c) => [c.sourcePeer ?? 'local', c.count]))

    assert.equal(byPeer['http://peer-a'], 2)
    assert.equal(byPeer['http://peer-b'], 1)
    assert.equal(byPeer['local'], 1)
    db.close()
  })
})

describe('peer operations', () => {
  test('upsert inserts and updates a peer', async () => {
    const db = makeDB()
    await db.upsertPeer({ url: 'http://peer-1', lastSyncAt: 0, healthy: true, nodeVersion: null, signerAddress: null })
    let peers = await db.getPeers()
    assert.equal(peers.length, 1)
    assert.equal(peers[0].url, 'http://peer-1')

    await db.upsertPeer({ url: 'http://peer-1', lastSyncAt: 9999, healthy: false, nodeVersion: '0.1.0', signerAddress: '0xabc' })
    peers = await db.getPeers()
    assert.equal(peers.length, 1)
    assert.equal(peers[0].lastSyncAt, 9999)
    assert.equal(peers[0].healthy, false)
    assert.equal(peers[0].nodeVersion, '0.1.0')
    db.close()
  })

  test('removePeer deletes a peer', async () => {
    const db = makeDB()
    await db.upsertPeer({ url: 'http://peer-x', lastSyncAt: 0, healthy: true, nodeVersion: null, signerAddress: null })
    await db.removePeer('http://peer-x')
    const peers = await db.getPeers()
    assert.equal(peers.length, 0)
    db.close()
  })
})
