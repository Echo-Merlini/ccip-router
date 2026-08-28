import { Hono } from 'hono'
import type { DB, MeshRecord } from '../db/types.js'
import {
  signTseiProfileAObservation,
  toTseiProfileAAttestation,
  TSEI_PROFILE_A_NAMESPACE,
} from './tseiProfileA.js'
import type { TseiProfileAAttestation } from './tseiProfileA.js'

export const DEFAULT_TSEI_PROFILE_A_MAX_RECEIPT_BYTES = 1_048_576

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
  now?: () => number
  maxReceiptBytes?: number
}

function isBytes32(value: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(value)
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
  const maxReceiptBytes = options.maxReceiptBytes ?? DEFAULT_TSEI_PROFILE_A_MAX_RECEIPT_BYTES

  if (!Number.isSafeInteger(maxReceiptBytes) || maxReceiptBytes <= 0) {
    throw new TypeError('maxReceiptBytes must be a positive safe integer')
  }

  router.post('/observations', async (c) => {
    if (!options.gatewayKey) {
      return c.json({
        error: 'SIGNING_UNAVAILABLE',
        message: 'GATEWAY_PRIVATE_KEY is required to attest a TSEI observation',
      }, 503)
    }

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
