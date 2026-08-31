import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export type Config = {
  port: number
  dbPath: string
  gatewayKey: `0x${string}` | null  // null = dry-run, no signing
  adminSecret: string | null        // null = open access (dev/local)
  peers: string[]
  syncInterval: string              // cron expression
  syncNamespace: string
  // ERC-8004 identity — optional, enables /identity endpoint and /health identity field
  agentId:         `0x${string}` | null
  registryAddress: `0x${string}` | null
  chainId:         number
  // WYRIWE / ERC-8281 (OCP) — optional, activates full attestation pipeline when combined with identity
  modelHash:       `0x${string}` | null  // bytes32 AI model identifier (keccak256 of weights CID)
  // Phase 2 on-chain anchoring — optional
  attestationIndex: `0x${string}` | null  // deployed AttestationIndex contract
  rpcUrl:           string | null          // JSON-RPC endpoint for reads + writes
  // Phase 3 open network — optional
  nodeUrl:          string | null          // this node's public URL (for VNI + NodeRegistry)
  nodeRegistry:     `0x${string}` | null  // deployed NodeRegistry contract (V1)
  nodeRegistryV2:   `0x${string}` | null  // deployed NodeRegistryV2 contract (with NodeType enum)
  nodeType:         number                   // 0=Origin 1=Router 2=Hybrid (default: 1)
  autoDiscover:     boolean               // pull peer lists from synced peers (default: true)
  // Admin auth — claimed via SIWE on first login, decoupled from gatewayKey
  adminAddress:     string | null
  // Decentralized CDN — optional, enables IPFS upload from admin panel
  cdnProvider:      'pinata' | 'storacha' | null
  cdnApiKey:        string | null
  // Mesh messages — optional, marks messages from this address as official
  networkKey:       string | null
  // Public node mode — disables admin panel entirely (no /admin routes mounted)
  disableAdmin:     boolean
  // On-chain CCIP-Read resolver contract (informational — shown in spec audit)
  resolverAddress:  `0x${string}` | null
  // ERC-8263 TruthAnchorV1 — optional second anchor target alongside AttestationIndex
  truthAnchorAddress: `0x${string}` | null
  // TSEI Profile A ingestion is an operator-only hot-key signing surface.
  tseiProfileAIngestSecret: string | null
  tseiProfileARateLimitMax: number
  tseiProfileARateLimitWindowSeconds: number
}

export type ConfigFile = {
  gatewayKey?: string
  adminSecret?: string
  namespace?: string
  syncInterval?: string
  dbPath?: string
  port?: number
  peers?: string[]
  // ERC-8004 identity
  agentId?: string
  registryAddress?: string
  chainId?: number
  modelHash?: string
  // Phase 2
  attestationIndex?: string
  rpcUrl?: string
  // Phase 3
  nodeUrl?: string
  nodeRegistry?: string
  nodeRegistryV2?: string
  nodeType?: number
  autoDiscover?: boolean
  adminAddress?: string
  cdnProvider?: string
  cdnApiKey?: string
  networkKey?: string
  disableAdmin?: boolean
  resolverAddress?: string
  truthAnchorAddress?: string
}

export const CONFIG_FILE_PATH = resolve(process.cwd(), process.env.CONFIG_PATH ?? 'config.json')

function loadConfigFile(): ConfigFile {
  if (!existsSync(CONFIG_FILE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8')) as ConfigFile
  } catch {
    console.warn(`[config] could not parse ${CONFIG_FILE_PATH} — ignoring`)
    return {}
  }
}

// True if the node has a signing key — either from env or config.json
export function isConfigured(): boolean {
  const file = loadConfigFile()
  return !!(process.env.GATEWAY_PRIVATE_KEY || file.gatewayKey)
}

function requireHex(key: string, val: string | undefined): `0x${string}` {
  if (!val) throw new Error(`${key} is required`)
  if (!val.startsWith('0x') || val.length < 4) throw new Error(`${key} must be a hex string starting with 0x`)
  return val as `0x${string}`
}

function parsePeers(val: string | undefined): string[] {
  if (!val || val.trim() === '') return []
  return val
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => {
      try { new URL(u) } catch { throw new Error(`Invalid peer URL: "${u}"`) }
      return u.replace(/\/$/, '') // strip trailing slash
    })
}

function parsePort(val: string | undefined): number {
  const n = Number(val ?? 3000)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`PORT must be 1–65535, got "${val}"`)
  return n
}

function parsePositiveSafeInteger(key: string, val: string | undefined, fallback: number): number {
  const n = Number(val ?? fallback)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive safe integer, got "${val}"`)
  }
  return n
}

export function loadConfig(): Config {
  const file = loadConfigFile()

  // env vars take precedence over config.json
  const raw = {
    PORT:                process.env.PORT                ?? String(file.port ?? ''),
    DB_PATH:             process.env.DB_PATH             ?? file.dbPath,
    GATEWAY_PRIVATE_KEY: process.env.GATEWAY_PRIVATE_KEY ?? file.gatewayKey,
    ADMIN_SECRET:        process.env.ADMIN_SECRET        ?? file.adminSecret,
    PEERS:               process.env.PEERS               ?? (file.peers ?? []).join(','),
    SYNC_INTERVAL:       process.env.SYNC_INTERVAL       ?? file.syncInterval,
    SYNC_NAMESPACE:      process.env.SYNC_NAMESPACE       ?? file.namespace,
    AGENT_ID:            process.env.AGENT_ID            ?? file.agentId,
    REGISTRY_ADDRESS:    process.env.REGISTRY_ADDRESS    ?? file.registryAddress,
    CHAIN_ID:            process.env.CHAIN_ID            ?? String(file.chainId ?? ''),
    MODEL_HASH:          process.env.MODEL_HASH          ?? file.modelHash,
    ATTESTATION_INDEX:   process.env.ATTESTATION_INDEX   ?? file.attestationIndex,
    RPC_URL:             process.env.RPC_URL             ?? file.rpcUrl,
    NODE_URL:            process.env.NODE_URL             ?? file.nodeUrl,
    NODE_REGISTRY:       process.env.NODE_REGISTRY        ?? file.nodeRegistry,
    NODE_REGISTRY_V2:    process.env.NODE_REGISTRY_V2      ?? file.nodeRegistryV2,
    NODE_TYPE:           process.env.NODE_TYPE               ?? String(file.nodeType ?? ''),
    AUTO_DISCOVER:       process.env.AUTO_DISCOVER        ?? String(file.autoDiscover ?? 'true'),
    CDN_PROVIDER:        process.env.CDN_PROVIDER         ?? file.cdnProvider,
    CDN_API_KEY:         process.env.CDN_API_KEY          ?? file.cdnApiKey,
    NETWORK_KEY:         process.env.NETWORK_KEY          ?? file.networkKey,
    DISABLE_ADMIN:       process.env.DISABLE_ADMIN        ?? String(file.disableAdmin ?? 'false'),
    RESOLVER_ADDRESS:    process.env.RESOLVER_ADDRESS     ?? file.resolverAddress,
    TRUTH_ANCHOR_ADDRESS: process.env.TRUTH_ANCHOR_ADDRESS ?? file.truthAnchorAddress,
    ADMIN_ADDRESS:       process.env.ADMIN_ADDRESS        ?? undefined,
    TSEI_PROFILE_A_INGEST_SECRET: process.env.TSEI_PROFILE_A_INGEST_SECRET,
    TSEI_PROFILE_A_RATE_LIMIT_MAX: process.env.TSEI_PROFILE_A_RATE_LIMIT_MAX,
    TSEI_PROFILE_A_RATE_LIMIT_WINDOW_SECONDS:
      process.env.TSEI_PROFILE_A_RATE_LIMIT_WINDOW_SECONDS,
  }

  const gatewayKey = raw.GATEWAY_PRIVATE_KEY
    ? requireHex('GATEWAY_PRIVATE_KEY', raw.GATEWAY_PRIVATE_KEY)
    : null

  if (!gatewayKey) {
    console.warn('[config] GATEWAY_PRIVATE_KEY not set — running in dry-run mode (no signing)')
  }

  const peers = parsePeers(raw.PEERS)

  const adminSecret = raw.ADMIN_SECRET?.trim() || null
  if (!adminSecret) {
    console.warn('[config] ADMIN_SECRET not set — admin dashboard is open (dev mode)')
  }

  const agentId = raw.AGENT_ID?.trim()
    ? requireHex('AGENT_ID', raw.AGENT_ID.trim())
    : null

  const registryAddress = raw.REGISTRY_ADDRESS?.trim()
    ? requireHex('REGISTRY_ADDRESS', raw.REGISTRY_ADDRESS.trim())
    : null

  const chainId = raw.CHAIN_ID ? Number(raw.CHAIN_ID) : 1

  const modelHash = raw.MODEL_HASH?.trim()
    ? requireHex('MODEL_HASH', raw.MODEL_HASH.trim())
    : null

  if (agentId) {
    console.log(`[config] identity:  agentId=${agentId.slice(0, 10)}... registry=${registryAddress ?? 'unset'} chainId=${chainId} modelHash=${modelHash ? modelHash.slice(0, 10) + '...' : 'unset'}`)
  }

  const attestationIndex = raw.ATTESTATION_INDEX?.trim()
    ? requireHex('ATTESTATION_INDEX', raw.ATTESTATION_INDEX.trim())
    : null

  const rpcUrl = raw.RPC_URL?.trim() || null

  if (attestationIndex) {
    console.log(`[config] chain:     attestationIndex=${attestationIndex} rpcUrl=${rpcUrl ?? 'unset'}`)
  }

  const nodeUrl      = raw.NODE_URL?.trim() || null
  const nodeRegistry = raw.NODE_REGISTRY?.trim()
    ? requireHex('NODE_REGISTRY', raw.NODE_REGISTRY.trim())
    : null
  const nodeRegistryV2 = (raw as any).NODE_REGISTRY_V2?.trim()
    ? requireHex('NODE_REGISTRY_V2', (raw as any).NODE_REGISTRY_V2.trim())
    : null
  const nodeType = Number((raw as any).NODE_TYPE?.trim() || '1') || 1 // 0=Origin 1=Router 2=Hybrid
    const autoDiscover = raw.AUTO_DISCOVER?.toLowerCase() !== 'false'

  if (nodeUrl) {
    console.log(`[config] node url:  ${nodeUrl}${nodeRegistryV2 ? ` registryV2=${nodeRegistryV2}` : nodeRegistry ? ` registry=${nodeRegistry}` : ''}`)
  }

  // ADMIN_ADDRESS env var takes precedence over config.json — use this on stateless deployments
  // (Railway, Fly, etc.) where config.json is wiped on every restart.
  const adminAddress = raw.ADMIN_ADDRESS?.trim() || file.adminAddress?.trim() || null
  if (raw.ADMIN_ADDRESS?.trim()) {
    console.log(`[config] admin:     locked to env ADMIN_ADDRESS=${adminAddress}`)
  }

  const rawCdnProvider = raw.CDN_PROVIDER?.trim().toLowerCase()
  const cdnProvider = (rawCdnProvider === 'pinata' || rawCdnProvider === 'storacha')
    ? rawCdnProvider
    : null
  const cdnApiKey  = raw.CDN_API_KEY?.trim() || null
  const networkKey   = raw.NETWORK_KEY?.trim() || null
  const disableAdmin = raw.DISABLE_ADMIN?.toLowerCase() === 'true'
  const resolverAddress = raw.RESOLVER_ADDRESS?.trim()
    ? requireHex('RESOLVER_ADDRESS', raw.RESOLVER_ADDRESS.trim())
    : null

  const truthAnchorAddress = (raw as any).TRUTH_ANCHOR_ADDRESS?.trim()
    ? requireHex('TRUTH_ANCHOR_ADDRESS', (raw as any).TRUTH_ANCHOR_ADDRESS.trim())
    : null

  if (truthAnchorAddress) {
    console.log(`[config] anchor:    truthAnchorAddress=${truthAnchorAddress} (ERC-8263)`)
  }

  const tseiProfileAIngestSecret = raw.TSEI_PROFILE_A_INGEST_SECRET?.trim() || null
  if (tseiProfileAIngestSecret && tseiProfileAIngestSecret.length < 32) {
    throw new Error('TSEI_PROFILE_A_INGEST_SECRET must be at least 32 characters')
  }
  const tseiProfileARateLimitMax = parsePositiveSafeInteger(
    'TSEI_PROFILE_A_RATE_LIMIT_MAX',
    raw.TSEI_PROFILE_A_RATE_LIMIT_MAX,
    60,
  )
  const tseiProfileARateLimitWindowSeconds = parsePositiveSafeInteger(
    'TSEI_PROFILE_A_RATE_LIMIT_WINDOW_SECONDS',
    raw.TSEI_PROFILE_A_RATE_LIMIT_WINDOW_SECONDS,
    60,
  )
  if (!tseiProfileAIngestSecret) {
    console.warn('[config] TSEI_PROFILE_A_INGEST_SECRET not set — TSEI Profile A ingestion disabled')
  }

  if (disableAdmin) {
    console.log('[config] admin:     disabled (public node mode)')
  }

  if (cdnProvider) {
    console.log(`[config] cdn:       provider=${cdnProvider}`)
  }

  return {
    port:             parsePort(raw.PORT),
    dbPath:           raw.DB_PATH ?? './data.db',
    gatewayKey,
    adminSecret,
    peers,
    syncInterval:     raw.SYNC_INTERVAL ?? '*/5 * * * *',
    syncNamespace:    raw.SYNC_NAMESPACE ?? 'agent-attestations',
    agentId,
    registryAddress,
    chainId,
    modelHash,
    attestationIndex,
    rpcUrl,
    nodeUrl,
    nodeRegistry,
    nodeRegistryV2,
    nodeType,
    autoDiscover,
    adminAddress,
    cdnProvider,
    cdnApiKey,
    networkKey,
    disableAdmin,
    resolverAddress,
    truthAnchorAddress,
    tseiProfileAIngestSecret,
    tseiProfileARateLimitMax,
    tseiProfileARateLimitWindowSeconds,
  }
}

// Singleton — parsed once at startup, imported everywhere
let _config: Config | null = null

export function getConfig(): Config {
  if (!_config) _config = loadConfig()
  return _config
}

// Persist adminAddress to config.json and update the in-memory singleton without restart.
// No-op when ADMIN_ADDRESS env var is set — env var is the immutable source of truth.
export function setAdminAddress(address: string): void {
  if (process.env.ADMIN_ADDRESS?.trim()) {
    console.warn('[config] ADMIN_ADDRESS env var is set — ignoring setAdminAddress (use env var to change)')
    return
  }
  if (_config) _config.adminAddress = address
  let existing: ConfigFile = {}
  if (existsSync(CONFIG_FILE_PATH)) {
    try { existing = JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8')) as ConfigFile } catch {}
  }
  writeFileSync(CONFIG_FILE_PATH, JSON.stringify({ ...existing, adminAddress: address }, null, 2), 'utf8')
  console.log(`[config] adminAddress set to ${address}`)
}

// Clear adminAddress — returns node to unclaimed state.
// No-op when ADMIN_ADDRESS env var is set.
export function clearAdminAddress(): void {
  if (process.env.ADMIN_ADDRESS?.trim()) {
    console.warn('[config] ADMIN_ADDRESS env var is set — cannot clear adminAddress via reset (remove the env var to unclaim)')
    return
  }
  if (_config) _config.adminAddress = null
  let existing: ConfigFile = {}
  if (existsSync(CONFIG_FILE_PATH)) {
    try { existing = JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf8')) as ConfigFile } catch {}
  }
  const { adminAddress: _removed, ...rest } = existing
  writeFileSync(CONFIG_FILE_PATH, JSON.stringify(rest, null, 2), 'utf8')
  console.log('[config] adminAddress cleared — node returned to unclaimed state')
}
