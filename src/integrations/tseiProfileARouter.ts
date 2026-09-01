import { Hono } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { DB, MeshRecord } from '../db/types.js'
import {
  signTseiProfileAObservation,
  toTseiProfileAAttestation,
  TSEI_PROFILE_A_NAMESPACE,
} from './tseiProfileA.js'
import type { TseiProfileAAttestation } from './tseiProfileA.js'

export const DEFAULT_TSEI_PROFILE_A_MAX_RECEIPT_BYTES = 1_048_576
export const DEFAULT_TSEI_PROFILE_A_RATE_LIMIT_MAX = 60
export const DEFAULT_TSEI_PROFILE_A_RATE_LIMIT_WINDOW_SECONDS = 60

export type TseiProfileAObservationValue = {
  value: string
  attestations: TseiProfileAAttestation[]
  invalid_attestations: number
}

export type TseiProfileAObservationState =
  | {
      input_hash: string
      namespace: typeof TSEI_PROFILE_A_NAMESPACE
      state: 'absent'
      values: []
    }
  | {
      input_hash: string
      namespace: typeof TSEI_PROFILE_A_NAMESPACE
      state: 'single' | 'divergent'
      values: TseiProfileAObservationValue[]
    }

export type TseiProfileARouterOptions = {
  db: DB
  gatewayKey?: `0x${string}`
  ingestSecret?: string
  now?: () => number
  rateLimitNow?: () => number
  maxReceiptBytes?: number
  rateLimitMax?: number
  rateLimitWindowSeconds?: number
}

function isBytes32(value: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(value)
}

function isAuthorizedBearer(authorization: string | undefined, secret: string): boolean {
  const candidate = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest()
  const secretDigest = createHash('sha256').update(secret, 'utf8').digest()
  return timingSafeEqual(candidateDigest, secretDigest) && candidate.length > 0
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
}

async function convertAttestations(records: MeshRecord[]): Promise<{
  attestations: TseiProfileAAttestation[]
  invalidAttestations: number
}> {
  const attestations: TseiProfileAAttestation[] = []
  let invalidAttestations = 0

  for (const record of records) {
    try {
      attestations.push(await toTseiProfileAAttestation(record))
    } catch {
      invalidAttestations += 1
    }
  }

  return { attestations, invalidAttestations }
}

/**
 * Read the complete TSEI Profile A observation state. Divergence is surfaced
 * as all distinct values and their signed attestations; no value is selected.
 */
export async function readTseiProfileAObservationState(
  db: DB,
  inputHash: string,
): Promise<TseiProfileAObservationState> {
  // Read raw records rather than getRecordState(): deployments may attach a
  // resolution policy to that method, but this endpoint is an evidence surface
  // and must never let such a policy hide a divergent value.
  const records = (await db.getRecordsByInputHash(inputHash))
    .filter((record) => record.namespace === TSEI_PROFILE_A_NAMESPACE)
  const observations = [...new Map(records.map((record) => [record.value, record])).values()]

  if (observations.length === 0) {
    return {
      input_hash: inputHash,
      namespace: TSEI_PROFILE_A_NAMESPACE,
      state: 'absent',
      values: [],
    }
  }

  const values: TseiProfileAObservationValue[] = []

  for (const observation of observations) {
    const records = await db.getSignedAttestations(
      inputHash,
      TSEI_PROFILE_A_NAMESPACE,
      observation.value,
    )
    const { attestations, invalidAttestations } = await convertAttestations(records)
    values.push({
      value: observation.value,
      attestations,
      invalid_attestations: invalidAttestations,
    })
  }

  return {
    input_hash: inputHash,
    namespace: TSEI_PROFILE_A_NAMESPACE,
    state: observations.length === 1 ? 'single' : 'divergent',
    values,
  }
}

/**
 * External TSEI → Profile A gateway surface.
 *
 * POST /observations accepts the exact public receipt bytes as the request
 * body. GET /observations/:inputHash returns the complete divergence-aware
 * observation state. The gateway signature identifies its vantage only; it
 * does not claim organizational, stranger, or oracle independence.
 */
export function createTseiProfileARouter(options: TseiProfileARouterOptions): Hono {
  const router = new Hono()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const rateLimitNow = options.rateLimitNow ?? Date.now
  const maxReceiptBytes = options.maxReceiptBytes ?? DEFAULT_TSEI_PROFILE_A_MAX_RECEIPT_BYTES
  const rateLimitMax = options.rateLimitMax ?? DEFAULT_TSEI_PROFILE_A_RATE_LIMIT_MAX
  const rateLimitWindowSeconds = options.rateLimitWindowSeconds
    ?? DEFAULT_TSEI_PROFILE_A_RATE_LIMIT_WINDOW_SECONDS
  const attemptTimes: number[] = []

  requirePositiveSafeInteger(maxReceiptBytes, 'maxReceiptBytes')
  requirePositiveSafeInteger(rateLimitMax, 'rateLimitMax')
  requirePositiveSafeInteger(rateLimitWindowSeconds, 'rateLimitWindowSeconds')
  if (!Number.isSafeInteger(rateLimitWindowSeconds * 1000)) {
    throw new TypeError('rateLimitWindowSeconds is too large')
  }

  router.post('/observations', async (c) => {
    if (!options.ingestSecret) {
      return c.json({
        error: 'INGEST_AUTH_UNAVAILABLE',
        message: 'TSEI_PROFILE_A_INGEST_SECRET is required to accept observations',
      }, 503)
    }

    if (!isAuthorizedBearer(c.req.header('authorization'), options.ingestSecret)) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ error: 'UNAUTHORIZED' }, 401)
    }

    if (!options.gatewayKey) {
      return c.json({
        error: 'SIGNING_UNAVAILABLE',
        message: 'GATEWAY_PRIVATE_KEY is required to attest a TSEI observation',
      }, 503)
    }

    const requestTime = rateLimitNow()
    if (!Number.isSafeInteger(requestTime) || requestTime < 0) {
      throw new TypeError('rateLimitNow must return a non-negative safe integer')
    }
    const windowMilliseconds = rateLimitWindowSeconds * 1000
    while (attemptTimes.length > 0 && requestTime - attemptTimes[0]! >= windowMilliseconds) {
      attemptTimes.shift()
    }
    if (attemptTimes.length >= rateLimitMax) {
      const retryAfter = Math.max(1, Math.ceil(
        (attemptTimes[0]! + windowMilliseconds - requestTime) / 1000,
      ))
      c.header('Retry-After', String(retryAfter))
      return c.json({
        error: 'RATE_LIMIT_EXCEEDED',
        limit: rateLimitMax,
        window_seconds: rateLimitWindowSeconds,
      }, 429)
    }
    attemptTimes.push(requestTime)

    const contentLength = c.req.header('content-length')
    if (contentLength !== undefined) {
      const declaredLength = Number(contentLength)
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
        return c.json({ error: 'INVALID_CONTENT_LENGTH' }, 400)
      }
      if (declaredLength > maxReceiptBytes) {
        return c.json({ error: 'RECEIPT_TOO_LARGE', max_bytes: maxReceiptBytes }, 413)
      }
    }

    const receiptBytes = new Uint8Array(await c.req.arrayBuffer())
    if (receiptBytes.byteLength > maxReceiptBytes) {
      return c.json({ error: 'RECEIPT_TOO_LARGE', max_bytes: maxReceiptBytes }, 413)
    }

    let record: MeshRecord
    try {
      record = await signTseiProfileAObservation(receiptBytes, now(), options.gatewayKey)
    } catch (error) {
      if (error instanceof TypeError) {
        return c.json({ error: 'INVALID_TSEI_RECEIPT', message: error.message }, 400)
      }
      throw error
    }

    await options.db.insertRecord(record)
    const attestation = await toTseiProfileAAttestation(record)
    const observation = await readTseiProfileAObservationState(options.db, record.inputHash)

    return c.json({ attestation, observation }, 201)
  })

  router.get('/observations/:inputHash', async (c) => {
    const inputHash = c.req.param('inputHash')
    if (!isBytes32(inputHash)) {
      return c.json({ error: 'INVALID_INPUT_HASH' }, 400)
    }

    const observation = await readTseiProfileAObservationState(options.db, inputHash)
    if (observation.state === 'absent') return c.json(observation, 404)
    return c.json(observation)
  })

  return router
}
