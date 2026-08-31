import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { recoverRecordSigner } from '../crypto/sign.js'
import { SQLiteDB } from '../db/sqlite.js'
import { TSEI_PROFILE_A_NAMESPACE } from '../integrations/tseiProfileA.js'
import { createTseiProfileARouter } from '../integrations/tseiProfileARouter.js'

// Hardhat dev key 0 — public and safe for tests only.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const TIMESTAMP = 1_787_584_157
const INPUT_HASH = '0xb17a5a2503494b793cc9ac5e7eaa6ff9dd5833c89af4e622005b4ede2d4c32c5'
const RECEIPT_SHA = '0x09349e8257da2b94227f7af7f8e4dcdcca9e715dc460e1f419e53a14a22e5a07'
const INGEST_SECRET = 'test-only-tsei-ingest-secret-0001'
const AUTHORIZATION = `Bearer ${INGEST_SECRET}`

const fixtureUrl = new URL(
  '../../conformance/tsei-profile-a-v0/fixtures/tsei-ia-real-v2-20260824-02.production-grounding.json',
  import.meta.url,
)

async function fixture(): Promise<Uint8Array> {
  return readFile(fixtureUrl)
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function authenticatedPost(bytes: Uint8Array | string): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: AUTHORIZATION },
    body: typeof bytes === 'string' ? bytes : requestBody(bytes),
  }
}

function replaceUtf8(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const text = new TextDecoder().decode(bytes)
  assert.ok(text.includes(from), `fixture must contain ${from}`)
  return new TextEncoder().encode(text.replace(from, to))
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

describe('TSEI Profile A gateway', () => {
  test('accepts exact receipt bytes, signs, stores, and returns a single state', async () => {
    const db = new SQLiteDB(':memory:')
    const router = createTseiProfileARouter({
      db,
      gatewayKey: KEY,
      ingestSecret: INGEST_SECRET,
      now: () => TIMESTAMP,
    })
    try {
      const post = await router.request('/observations', authenticatedPost(await fixture()))
      assert.equal(post.status, 201)
      const created = await json(post)
      const attestation = created.attestation as Record<string, unknown>
      const observation = created.observation as Record<string, unknown>
      assert.equal(attestation.input_hash, INPUT_HASH)
      assert.equal(attestation.value, RECEIPT_SHA)
      assert.equal(String(attestation.signer).toLowerCase(), ADDRESS.toLowerCase())
      assert.equal(observation.state, 'single')

      const state = await db.getRecordState(INPUT_HASH, TSEI_PROFILE_A_NAMESPACE)
      assert.equal(state.state, 'single')
      if (state.state === 'single') {
        assert.equal((await recoverRecordSigner(state.record)).toLowerCase(), ADDRESS.toLowerCase())
      }

      const get = await router.request(`/observations/${INPUT_HASH}`)
      assert.equal(get.status, 200)
      const fetched = await json(get)
      assert.equal(fetched.state, 'single')
      const values = fetched.values as Array<Record<string, unknown>>
      assert.equal(values.length, 1)
      assert.equal(values[0]?.value, RECEIPT_SHA)
      assert.equal((values[0]?.attestations as unknown[]).length, 1)
      assert.equal(values[0]?.invalid_attestations, 0)
    } finally {
      db.close()
    }
  })

  test('refuses writes when the gateway signing key is unavailable', async () => {
    const db = new SQLiteDB(':memory:')
    const router = createTseiProfileARouter({
      db,
      ingestSecret: INGEST_SECRET,
      now: () => TIMESTAMP,
    })
    try {
      const response = await router.request('/observations', authenticatedPost(await fixture()))
      assert.equal(response.status, 503)
      assert.equal((await json(response)).error, 'SIGNING_UNAVAILABLE')
      assert.deepEqual(await db.getRecordState(INPUT_HASH, TSEI_PROFILE_A_NAMESPACE), { state: 'absent' })
    } finally {
      db.close()
    }
  })

  test('same exact receipt twice stays single and retains both attestations', async () => {
    const db = new SQLiteDB(':memory:')
    let timestamp = TIMESTAMP
    const router = createTseiProfileARouter({
      db,
      gatewayKey: KEY,
      ingestSecret: INGEST_SECRET,
      now: () => timestamp++,
    })
    try {
      const bytes = await fixture()
      assert.equal((await router.request('/observations', authenticatedPost(bytes))).status, 201)
      assert.equal((await router.request('/observations', authenticatedPost(bytes))).status, 201)

      const response = await router.request(`/observations/${INPUT_HASH}`)
      const state = await json(response)
      assert.equal(state.state, 'single')
      const values = state.values as Array<Record<string, unknown>>
      assert.equal(values.length, 1)
      assert.equal((values[0]?.attestations as unknown[]).length, 2)
    } finally {
      db.close()
    }
  })

  test('changed exact bytes for one instance surface divergence without choosing a winner', async () => {
    const db = new SQLiteDB(':memory:')
    let timestamp = TIMESTAMP
    const router = createTseiProfileARouter({
      db,
      gatewayKey: KEY,
      ingestSecret: INGEST_SECRET,
      now: () => timestamp++,
    })
    try {
      const original = await fixture()
      const changed = replaceUtf8(
        original,
        'PRODUCTION_GROUNDING_MINTED_REAL_RUN_NOT_CLAIMED',
        'PRODUCTION_GROUNDING_REPORTED_REAL_RUN_NOT_CLAIMED',
      )
      assert.equal((await router.request('/observations', authenticatedPost(original))).status, 201)
      assert.equal((await router.request('/observations', authenticatedPost(changed))).status, 201)

      // Even a deployment-level resolution hook must not hide divergence from
      // this evidence endpoint.
      db.resolveDivergence = (stored) => stored.state === 'divergent'
        ? { state: 'single', record: stored.records[0]! }
        : stored

      const response = await router.request(`/observations/${INPUT_HASH}`)
      const state = await json(response)
      assert.equal(state.state, 'divergent')
      const values = state.values as Array<Record<string, unknown>>
      assert.equal(values.length, 2)
      assert.equal(new Set(values.map((value) => value.value)).size, 2)
      assert.equal(values.reduce(
        (count, value) => count + (value.attestations as unknown[]).length,
        0,
      ), 2)
      assert.equal('winner' in state, false)
    } finally {
      db.close()
    }
  })

  test('rejects malformed, oversized, invalid-hash, and absent requests fail-closed', async () => {
    const db = new SQLiteDB(':memory:')
    const router = createTseiProfileARouter({
      db,
      gatewayKey: KEY,
      ingestSecret: INGEST_SECRET,
      now: () => TIMESTAMP,
      maxReceiptBytes: 32,
    })
    try {
      const malformed = await router.request('/observations', authenticatedPost('{not-json}'))
      assert.equal(malformed.status, 400)
      assert.equal((await json(malformed)).error, 'INVALID_TSEI_RECEIPT')

      const oversized = await router.request('/observations', authenticatedPost(new Uint8Array(33)))
      assert.equal(oversized.status, 413)
      assert.equal((await json(oversized)).error, 'RECEIPT_TOO_LARGE')

      const invalidHash = await router.request('/observations/not-a-hash')
      assert.equal(invalidHash.status, 400)
      assert.equal((await json(invalidHash)).error, 'INVALID_INPUT_HASH')

      const absentHash = `0x${'00'.repeat(32)}`
      const absent = await router.request(`/observations/${absentHash}`)
      assert.equal(absent.status, 404)
      assert.equal((await json(absent)).state, 'absent')
    } finally {
      db.close()
    }
  })

  test('fails closed when ingestion auth is unavailable or invalid while reads remain public', async () => {
    const db = new SQLiteDB(':memory:')
    const disabled = createTseiProfileARouter({ db, gatewayKey: KEY, now: () => TIMESTAMP })
    const protectedRouter = createTseiProfileARouter({
      db,
      gatewayKey: KEY,
      ingestSecret: INGEST_SECRET,
      now: () => TIMESTAMP,
    })
    try {
      const unavailable = await disabled.request('/observations', {
        method: 'POST',
        body: requestBody(await fixture()),
      })
      assert.equal(unavailable.status, 503)
      assert.equal((await json(unavailable)).error, 'INGEST_AUTH_UNAVAILABLE')

      const missing = await protectedRouter.request('/observations', {
        method: 'POST',
        body: requestBody(await fixture()),
      })
      assert.equal(missing.status, 401)
      assert.equal(missing.headers.get('www-authenticate'), 'Bearer')

      const wrong = await protectedRouter.request('/observations', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-secret' },
        body: requestBody(await fixture()),
      })
      assert.equal(wrong.status, 401)
      assert.deepEqual(await db.getRecordState(INPUT_HASH, TSEI_PROFILE_A_NAMESPACE), { state: 'absent' })

      const publicRead = await protectedRouter.request(`/observations/${INPUT_HASH}`)
      assert.equal(publicRead.status, 404)
      assert.equal((await json(publicRead)).state, 'absent')
    } finally {
      db.close()
    }
  })

  test('rate limits authenticated signing attempts and publishes Retry-After', async () => {
    const db = new SQLiteDB(':memory:')
    let rateLimitTime = 1_000
    const router = createTseiProfileARouter({
      db,
      gatewayKey: KEY,
      ingestSecret: INGEST_SECRET,
      now: () => TIMESTAMP,
      rateLimitNow: () => rateLimitTime,
      rateLimitMax: 2,
      rateLimitWindowSeconds: 60,
    })
    try {
      const bytes = await fixture()
      const unauthorized = await router.request('/observations', {
        method: 'POST',
        headers: { Authorization: 'Bearer not-the-ingest-secret' },
        body: requestBody(bytes),
      })
      assert.equal(unauthorized.status, 401)

      assert.equal((await router.request('/observations', authenticatedPost(bytes))).status, 201)
      assert.equal((await router.request('/observations', authenticatedPost(bytes))).status, 201)

      const limited = await router.request('/observations', authenticatedPost(bytes))
      assert.equal(limited.status, 429)
      assert.equal(limited.headers.get('retry-after'), '60')
      assert.deepEqual(await json(limited), {
        error: 'RATE_LIMIT_EXCEEDED',
        limit: 2,
        window_seconds: 60,
      })

      rateLimitTime += 60_000
      assert.equal((await router.request('/observations', authenticatedPost(bytes))).status, 201)
    } finally {
      db.close()
    }
  })

  test('rejects invalid rate-limit configuration at construction', () => {
    const db = new SQLiteDB(':memory:')
    try {
      assert.throws(
        () => createTseiProfileARouter({ db, rateLimitMax: 0 }),
        /rateLimitMax must be a positive safe integer/,
      )
      assert.throws(
        () => createTseiProfileARouter({
          db,
          rateLimitWindowSeconds: Number.MAX_SAFE_INTEGER,
        }),
        /rateLimitWindowSeconds is too large/,
      )
    } finally {
      db.close()
    }
  })
})
