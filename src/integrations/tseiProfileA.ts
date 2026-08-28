import { createHash } from 'node:crypto'
import { keccak256, toHex } from 'viem'
import { recoverRecordSigner, signRecord } from '../crypto/sign.js'
import type { MeshRecord } from '../db/types.js'

export const TSEI_PROFILE_A_NAMESPACE = 'tsei.public-production-grounding-receipt.v1'
export const TSEI_PROFILE_A_INPUT_DOMAIN = 'TSEI-PROFILE-A-OBSERVATION-v0'
export const TSEI_PROFILE_A_VANTAGE_CLASS = 'ccip-gateway-signed-receipt'

type JsonObject = Record<string, unknown>

export type TseiReceiptInspection = {
  instanceId: string
  receiptSha256: `0x${string}`
}

export type TseiProfileAAttestation = {
  input_hash: string
  namespace: string
  value: string
  signer: string
  signature: string
  vantage_class: typeof TSEI_PROFILE_A_VANTAGE_CLASS
}

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`${label} must be a JSON object`)
  }
  return value as JsonObject
}

function decodeExactUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new TypeError('TSEI receipt bytes must be valid UTF-8')
  }
}

function sha256Hex(bytes: Uint8Array): `0x${string}` {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Inspect exact TSEI public-receipt bytes without normalising or repairing them.
 *
 * The adapter validates only the identity-bearing envelope needed for routing.
 * It does not re-run TSEI, does not open private operands, and does not turn a
 * receipt's reported status into an ERC-8309 independence or finality claim.
 */
export function inspectTseiPublicReceipt(receiptBytes: Uint8Array): TseiReceiptInspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeExactUtf8(receiptBytes))
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError('TSEI receipt bytes must contain one valid JSON value')
  }

  const receipt = asObject(parsed, 'TSEI receipt')
  if (receipt.schema !== 'tsei-v2-public-production-grounding-receipt.v1') {
    throw new TypeError('unsupported TSEI public-receipt schema')
  }
  if (typeof receipt.instance_id !== 'string' || receipt.instance_id.length === 0) {
    throw new TypeError('TSEI receipt instance_id must be a non-empty string')
  }

  // Require the receipt families this adapter promises to transport. Their
  // contents remain opaque here; semantic verification belongs to TSEI.
  asObject(receipt.artifact_grounding, 'TSEI receipt artifact_grounding')
  asObject(receipt.evidence_chain, 'TSEI receipt evidence_chain')
  asObject(receipt.production_outcome, 'TSEI receipt production_outcome')
  asObject(receipt.limitations, 'TSEI receipt limitations')
  if (typeof receipt.status !== 'string' || receipt.status.length === 0) {
    throw new TypeError('TSEI receipt status must be a non-empty string')
  }

  return {
    instanceId: receipt.instance_id,
    receiptSha256: sha256Hex(receiptBytes),
  }
}

function requireTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('timestamp must be a non-negative safe integer')
  }
}

/**
 * Deterministically map exact TSEI receipt bytes to the CCIP observation that
 * Profile A consumes.
 *
 * - inputHash identifies the TSEI instance, so different receipts for the same
 *   instance remain comparable and can surface as divergence.
 * - value is SHA-256 of the exact receipt bytes, so no semantic projection or
 *   whitespace repair can silently collapse distinct artifacts.
 * - signature is deliberately "0x" until the normal ccip-router signing path
 *   signs the record. An unsigned record never gains signer weight.
 */
export function makeUnsignedTseiProfileAObservation(
  receiptBytes: Uint8Array,
  timestamp: number,
): MeshRecord {
  requireTimestamp(timestamp)
  const inspected = inspectTseiPublicReceipt(receiptBytes)
  const inputHash = keccak256(toHex(
    `${TSEI_PROFILE_A_INPUT_DOMAIN}\u0000${inspected.instanceId}`,
  ))

  return {
    inputHash,
    namespace: TSEI_PROFILE_A_NAMESPACE,
    key: inputHash,
    value: inspected.receiptSha256,
    timestamp,
    signature: '0x',
    sourcePeer: null,
  }
}

/** Sign the deterministic observation through ccip-router's existing EIP-191 path. */
export async function signTseiProfileAObservation(
  receiptBytes: Uint8Array,
  timestamp: number,
  gatewayKey: `0x${string}`,
): Promise<MeshRecord> {
  const unsigned = makeUnsignedTseiProfileAObservation(receiptBytes, timestamp)
  const signature = await signRecord(
    unsigned.inputHash as `0x${string}`,
    unsigned.namespace,
    unsigned.value as `0x${string}`,
    unsigned.timestamp,
    gatewayKey,
  )
  return { ...unsigned, signature }
}

/**
 * Convert a signed mesh record into the exact observation fields consumed by
 * Profile A. Signer identity is recovered from the signature; sourcePeer is
 * deliberately excluded because transport metadata is not authority.
 *
 * The constant vantage class describes the observation mechanism only. It is
 * not an ERC-8309 independence claim; Profile A's envelope keeps E3 false.
 */
export async function toTseiProfileAAttestation(
  record: MeshRecord,
): Promise<TseiProfileAAttestation> {
  if (record.namespace !== TSEI_PROFILE_A_NAMESPACE) {
    throw new TypeError('record is not in the TSEI Profile A namespace')
  }
  if (record.key !== record.inputHash) {
    throw new TypeError('TSEI Profile A record key must equal inputHash')
  }
  if (!/^0x[0-9a-f]{64}$/i.test(record.inputHash)) {
    throw new TypeError('TSEI Profile A inputHash must be 32-byte hex')
  }
  if (!/^0x[0-9a-f]{64}$/i.test(record.value)) {
    throw new TypeError('TSEI Profile A value must be a 32-byte receipt digest')
  }
  if (!/^0x[0-9a-f]{130}$/i.test(record.signature)) {
    throw new TypeError('TSEI Profile A observation requires a 65-byte signature')
  }

  const signer = await recoverRecordSigner(record)
  return {
    input_hash: record.inputHash,
    namespace: record.namespace,
    value: record.value,
    signer,
    signature: record.signature,
    vantage_class: TSEI_PROFILE_A_VANTAGE_CLASS,
  }
}
