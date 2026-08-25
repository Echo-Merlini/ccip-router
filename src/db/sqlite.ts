import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { SCHEMA, MIGRATIONS } from './schema.js'
import type { DB, MeshRecord, RecordState, PeerState, Contribution, NameRecord, Message, MessageType, JoinRequest } from './types.js'

type EnsRow = {
  name:        string
  type:        string
  coin_type:   number
  text_key:    string
  value:       string
  modified_at: number
}

type RecordRow = {
  input_hash: string
  namespace: string
  key: string
  value: string
  timestamp: number
  signature: string
  source_peer: string | null
}

type PeerRow = {
  url: string
  last_sync_at: number
  healthy: number
  node_version: string | null
  signer_address: string | null
}

type JoinRequestRow = {
  id:             number
  url:            string
  signature:      string
  signer_address: string
  status:         string
  health_ok:      number
  health_data:    string | null
  created_at:     number
}

export class SQLiteDB implements DB {
  private db: Database.Database

  private stmts: {
    insert: Database.Statement
    getSince: Database.Statement
    getSinceAfterCursor: Database.Statement
    getOne: Database.Statement
    getOneNs: Database.Statement
    getAllByHash: Database.Statement
    getAllByHashNs: Database.Statement
    insertAttestation: Database.Statement
    getAttestationsFor: Database.Statement
    getSignedAttestationsFor: Database.Statement
    upsertPeer: Database.Statement
    getPeers: Database.Statement
    count: Database.Statement
    ensNameCount: Database.Statement
    recent: Database.Statement
    removePeer: Database.Statement
    contributions: Database.Statement
    doubleSigns: Database.Statement
    ensUpsert: Database.Statement
    ensDelete: Database.Statement
    ensGet: Database.Statement
    ensList: Database.Statement
    ensListAll: Database.Statement
    msgInsert:      Database.Statement
    msgList:        Database.Statement
    msgMarkRead:    Database.Statement
    msgMarkAllRead: Database.Statement
    msgUnreadCount: Database.Statement
    jrUpsert:       Database.Statement
    jrList:         Database.Statement
    jrListStatus:   Database.Statement
    jrUpdateStatus: Database.Statement
    jrGetById:      Database.Statement
    blockPeer:      Database.Statement
    isBlockedPeer:  Database.Statement
    contributionsWithAddrs: Database.Statement
    snapshotGet:             Database.Statement
    snapshotInsert:          Database.Statement
    snapshotFreeze:          Database.Statement
    snapshotSetStatus:       Database.Statement
  }

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.runMigrations()

    this.stmts = {
      insert: this.db.prepare(`
        INSERT OR IGNORE INTO records
          (input_hash, namespace, key, value, timestamp, signature, source_peer)
        VALUES
          (@inputHash, @namespace, @key, @value, @timestamp, @signature, @sourcePeer)
      `),

      // cursor is composite: timestamp|input_hash — avoids skipping records
      // when multiple records share the same timestamp
      getSince: this.db.prepare(`
        SELECT * FROM records
        WHERE namespace = @namespace AND timestamp > @since
        ORDER BY timestamp ASC, input_hash ASC
        LIMIT @limit
      `),

      getSinceAfterCursor: this.db.prepare(`
        SELECT * FROM records
        WHERE namespace = @namespace
          AND (
            timestamp > @cursorTs
            OR (timestamp = @cursorTs AND input_hash > @cursorHash)
          )
        ORDER BY timestamp ASC, input_hash ASC
        LIMIT @limit
      `),

      // first match across all namespaces (basic tier lookup)
      getOne: this.db.prepare(`
        SELECT * FROM records WHERE input_hash = ? LIMIT 1
      `),

      // exact match on composite PK
      getOneNs: this.db.prepare(`
        SELECT * FROM records WHERE input_hash = ? AND namespace = ?
      `),

      // all records for an inputHash across every namespace (used by /verify)
      getAllByHash: this.db.prepare(`
        SELECT * FROM records WHERE input_hash = ? ORDER BY namespace ASC
      `),

      // ERC-8309: every stored observation for one (input_hash, namespace).
      // >1 row here means genuine multi-vantage divergence — surfaced, not dropped.
      getAllByHashNs: this.db.prepare(`
        SELECT * FROM records WHERE input_hash = ? AND namespace = ?
        ORDER BY timestamp ASC, value ASC
      `),

      // ERC-8309 attestation retention: every distinct signed message is kept (signature is
      // NOT NULL); an exact replay (same signature) is an idempotent no-op.
      insertAttestation: this.db.prepare(`
        INSERT OR IGNORE INTO attestations
          (input_hash, namespace, key, value, timestamp, signature, source_peer, attestation_id, signed)
        VALUES
          (@inputHash, @namespace, @key, @value, @timestamp, @signature, @sourcePeer, @attestationId, @signed)
      `),

      getAttestationsFor: this.db.prepare(`
        SELECT * FROM attestations WHERE input_hash = ? AND namespace = ? AND value = ?
        ORDER BY timestamp ASC, attestation_id ASC
      `),

      // V2 / §7.1 eligibility: only signed attestations mint signer weight. "0x" is observable but
      // never counted. A companion still cryptographically verifies before counting.
      getSignedAttestationsFor: this.db.prepare(`
        SELECT * FROM attestations WHERE input_hash = ? AND namespace = ? AND value = ? AND signed = 1
        ORDER BY timestamp ASC, attestation_id ASC
      `),

      upsertPeer: this.db.prepare(`
        INSERT INTO peers (url, last_sync_at, healthy, node_version, signer_address)
        VALUES (@url, @lastSyncAt, @healthy, @nodeVersion, @signerAddress)
        ON CONFLICT(url) DO UPDATE SET
          last_sync_at   = excluded.last_sync_at,
          healthy        = excluded.healthy,
          node_version   = excluded.node_version,
          signer_address = excluded.signer_address
      `),

      getPeers: this.db.prepare(`SELECT * FROM peers`),

      count: this.db.prepare(`
        SELECT COUNT(*) as n FROM records WHERE namespace = ?
      `),

      ensNameCount: this.db.prepare(`
        SELECT COUNT(DISTINCT name) as n FROM ens_records
      `),

      recent: this.db.prepare(`
        SELECT * FROM records
        WHERE namespace = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `),

      removePeer: this.db.prepare(`DELETE FROM peers WHERE url = ?`),

      contributions: this.db.prepare(`
        SELECT source_peer, COUNT(*) as count
        FROM records WHERE namespace = ?
        GROUP BY source_peer ORDER BY count DESC
      `),

      // double-sign: same signer submitted the same (input_hash, namespace) with a different
      // signature — slashable equivocation. Different signers attesting the same input is
      // normal multi-node mesh behaviour and must NOT be flagged.
      doubleSigns: this.db.prepare(`
        SELECT input_hash FROM records
        WHERE input_hash  = @inputHash
          AND namespace   = @namespace
          AND source_peer = @sourcePeer
          AND signature  != @signature
      `),

      ensUpsert: this.db.prepare(`
        INSERT INTO ens_records (name, type, coin_type, text_key, value, modified_at)
        VALUES (@name, @type, @coinType, @textKey, @value, @modifiedAt)
        ON CONFLICT (name, type, coin_type, text_key) DO UPDATE SET
          value       = excluded.value,
          modified_at = excluded.modified_at
      `),

      ensDelete: this.db.prepare(`
        DELETE FROM ens_records
        WHERE name = @name AND type = @type AND coin_type = @coinType AND text_key = @textKey
      `),

      ensGet: this.db.prepare(`
        SELECT value FROM ens_records
        WHERE name = @name AND type = @type AND coin_type = @coinType AND text_key = @textKey
      `),

      ensList: this.db.prepare(`
        SELECT * FROM ens_records WHERE name = ? ORDER BY type ASC, coin_type ASC, text_key ASC
      `),

      ensListAll: this.db.prepare(`
        SELECT * FROM ens_records ORDER BY name ASC, type ASC, coin_type ASC, text_key ASC
      `),

      msgInsert: this.db.prepare(`
        INSERT INTO messages (from_url, from_signer, type, body, version, signature, timestamp, official)
        VALUES (@fromUrl, @fromSigner, @type, @body, @version, @signature, @timestamp, @official)
      `),

      msgList: this.db.prepare(`
        SELECT * FROM messages ORDER BY received_at DESC LIMIT ?
      `),

      msgMarkRead: this.db.prepare(`
        UPDATE messages SET read = 1 WHERE id = ?
      `),

      msgMarkAllRead: this.db.prepare(`
        UPDATE messages SET read = 1 WHERE read = 0
      `),

      msgUnreadCount: this.db.prepare(`
        SELECT COUNT(*) as count FROM messages WHERE read = 0
      `),

      jrUpsert: this.db.prepare(`
        INSERT INTO join_requests (url, signature, signer_address, status, health_ok, health_data)
        VALUES (@url, @signature, @signerAddress, @status, @healthOk, @healthData)
        ON CONFLICT(signer_address) DO UPDATE SET
          url         = excluded.url,
          signature   = excluded.signature,
          status      = excluded.status,
          health_ok   = excluded.health_ok,
          health_data = excluded.health_data,
          created_at  = strftime('%s','now')
      `),

      jrList: this.db.prepare(`
        SELECT * FROM join_requests ORDER BY created_at DESC
      `),

      jrListStatus: this.db.prepare(`
        SELECT * FROM join_requests WHERE status = ? ORDER BY created_at DESC
      `),

      jrUpdateStatus: this.db.prepare(`
        UPDATE join_requests SET status = ? WHERE id = ?
      `),

      jrGetById: this.db.prepare(`
        SELECT id FROM join_requests WHERE signer_address = @signerAddress
      `),

      blockPeer: this.db.prepare(`
        INSERT OR IGNORE INTO peer_blocklist (url) VALUES (?)
      `),

      isBlockedPeer: this.db.prepare(`
        SELECT 1 FROM peer_blocklist WHERE url = ?
      `),

      contributionsWithAddrs: this.db.prepare(`
        SELECT r.source_peer, COUNT(*) as count, p.signer_address
        FROM records r
        LEFT JOIN peers p ON r.source_peer = p.url
        WHERE r.namespace = ?
        GROUP BY r.source_peer
        ORDER BY count DESC
      `),

      snapshotGet: this.db.prepare(`
        SELECT * FROM snapshots WHERE period_id = ?
      `),

      snapshotInsert: this.db.prepare(`
        INSERT OR IGNORE INTO snapshots (period_id, snapshot_cutoff, status)
        VALUES (?, ?, 'pending')
      `),

      snapshotFreeze: this.db.prepare(`
        UPDATE snapshots
        SET frozen_at = @frozenAt, row_count = @rowCount,
            snapshot_root = @snapshotRoot, commitment_hash = @commitmentHash,
            node_address = @nodeAddress, status = 'frozen'
        WHERE period_id = @periodId AND status = 'pending'
      `),

      snapshotSetStatus: this.db.prepare(`
        UPDATE snapshots SET status = ? WHERE period_id = ?
      `),
    }

    this.backfillAttestations()
  }

  // One-time reclassifying backfill: populate attestations from records with the correct per-row
  // identity (canonical signature when signed, content digest when not) and signed flag. Idempotent;
  // runs only when attestations is empty but records is not (right after the v8 migration), so pre-v8
  // rows — including unsigned "0x" ones — are classified, never copied in as "0x" collisions.
  private backfillAttestations(): void {
    const att = this.db.prepare(`SELECT COUNT(*) AS n FROM attestations`).get() as { n: number }
    if (att.n > 0) return
    const recs = this.db.prepare(`SELECT * FROM records`).all() as RecordRow[]
    if (recs.length === 0) return
    const tx = this.db.transaction((rows: RecordRow[]) => {
      for (const row of rows) {
        const r = toMeshRecord(row)
        const id = attestationIdentity(r)
        this.stmts.insertAttestation.run({
          inputHash: r.inputHash, namespace: r.namespace, key: r.key, value: r.value,
          timestamp: r.timestamp, signature: r.signature, sourcePeer: r.sourcePeer,
          attestationId: id.id, signed: id.signed,
        })
      }
    })
    tx(recs)
  }

  // Run pending migrations in order, tracking applied versions in schema_version.
  private runMigrations() {
    const applied = this.db
      .prepare(`SELECT version FROM schema_version ORDER BY version ASC`)
      .all() as { version: number }[]
    const appliedVersions = new Set(applied.map((r) => r.version))

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue
      console.log(`[db] applying migration v${migration.version}`)
      this.db.exec(migration.sql)
      this.db
        .prepare(`INSERT INTO schema_version (version) VALUES (?)`)
        .run(migration.version)
    }
  }

  async insertRecord(record: MeshRecord): Promise<void> {
    const existing = this.stmts.doubleSigns.get({
      inputHash:  record.inputHash,
      namespace:  record.namespace,
      sourcePeer: record.sourcePeer,
      signature:  record.signature,
    })
    if (existing) {
      console.warn(`[double-sign] input_hash=${record.inputHash} ns=${record.namespace} signer=${record.sourcePeer} — flagged for future slashing`)
    }

    this.stmts.insert.run({
      inputHash:  record.inputHash,
      namespace:  record.namespace,
      key:        record.key,
      value:      record.value,
      timestamp:  record.timestamp,
      signature:  record.signature,
      sourcePeer: record.sourcePeer,
    })

    // Retain the signed message for per-value corroboration (quorum-class policies count vantages).
    // records keeps one observation per value; attestations keeps every distinct signature.
    const att = attestationIdentity(record)  // low-s-canonical signature if signed; content digest if not
    this.stmts.insertAttestation.run({
      inputHash:     record.inputHash,
      namespace:     record.namespace,
      key:           record.key,
      value:         record.value,
      timestamp:     record.timestamp,
      signature:     record.signature,   // as received; attestation_id carries the canonical dedup key
      sourcePeer:    record.sourcePeer,
      attestationId: att.id,
      signed:        att.signed,
    })
  }

  // ERC-8309 attestation retention: the distinct signed messages attesting a specific value, in
  // ingest order. Corroboration count = attestations of one value; the base retains them, a quorum
  // profile weighs them. Empty when the value was never attested.
  async getAttestations(inputHash: string, namespace: string, value: string): Promise<MeshRecord[]> {
    const rows = this.stmts.getAttestationsFor.all(inputHash, namespace, value) as RecordRow[]
    return rows.map(toMeshRecord)
  }

  // The signed (structurally eligible) attestations for a value — the set V2 / §7.1 counting operates
  // on. Unsigned "0x"/dry-run records are excluded here (observable via getAttestations, never counted).
  // Structural only: a companion still cryptographically verifies each before minting signer weight.
  async getSignedAttestations(inputHash: string, namespace: string, value: string): Promise<MeshRecord[]> {
    const rows = this.stmts.getSignedAttestationsFor.all(inputHash, namespace, value) as RecordRow[]
    return rows.map(toMeshRecord)
  }

  async getRecordsSince(
    namespace: string,
    since: number,
    limit: number,
    cursor?: string,
  ): Promise<MeshRecord[]> {
    let rows: RecordRow[]

    if (cursor) {
      const [cursorTs, cursorHash] = cursor.split('|')
      rows = this.stmts.getSinceAfterCursor.all({
        namespace,
        cursorTs:   Number(cursorTs),
        cursorHash,
        limit,
      }) as RecordRow[]
    } else {
      rows = this.stmts.getSince.all({ namespace, since, limit }) as RecordRow[]
    }

    return rows.map(toMeshRecord)
  }

  async getRecord(inputHash: string, namespace?: string): Promise<MeshRecord | null> {
    const row = namespace
      ? this.stmts.getOneNs.get(inputHash, namespace) as RecordRow | undefined
      : this.stmts.getOne.get(inputHash) as RecordRow | undefined
    return row ? toMeshRecord(row) : null
  }

  async getRecordsByInputHash(inputHash: string): Promise<MeshRecord[]> {
    const rows = this.stmts.getAllByHash.all(inputHash) as RecordRow[]
    return rows.map(toMeshRecord)
  }

  // ERC-8309 divergence-aware read surface. Returns the record-store state for a
  // key as {single | divergent | absent} — never a silently-chosen winner, and
  // never divergence represented as agreement. This is the named extension point:
  // a deployment MAY attach a declared resolution policy by overriding
  // resolveDivergence; the default surfaces divergence and resolves nothing.
  resolveDivergence: (s: RecordState) => RecordState = (s) => s

  async getRecordState(inputHash: string, namespace: string): Promise<RecordState> {
    const rows = this.stmts.getAllByHashNs.all(inputHash, namespace) as RecordRow[]
    if (rows.length === 0) return { state: 'absent' }
    const records = rows.map(toMeshRecord)
    const state: RecordState = records.length === 1
      ? { state: 'single', record: records[0] }
      : { state: 'divergent', records }
    return this.resolveDivergence(state)
  }

  async upsertPeer(peer: PeerState): Promise<void> {
    this.stmts.upsertPeer.run({
      url:           peer.url,
      lastSyncAt:    peer.lastSyncAt,
      healthy:       peer.healthy ? 1 : 0,
      nodeVersion:   peer.nodeVersion,
      signerAddress: peer.signerAddress,
    })
  }

  async getPeers(): Promise<PeerState[]> {
    const rows = this.stmts.getPeers.all() as PeerRow[]
    return rows.map(toPeerState)
  }

  async recordCount(namespace: string): Promise<number> {
    const row = this.stmts.count.get(namespace) as { n: number }
    return row.n
  }

  async ensNameCount(): Promise<number> {
    const row = this.stmts.ensNameCount.get() as { n: number }
    return row.n
  }

  async getRecentRecords(namespace: string, limit: number): Promise<MeshRecord[]> {
    const rows = this.stmts.recent.all(namespace, limit) as RecordRow[]
    return rows.map(toMeshRecord)
  }

  async getContributions(namespace: string): Promise<Contribution[]> {
    const rows = this.stmts.contributions.all(namespace) as { source_peer: string | null; count: number }[]
    return rows.map((r) => ({ sourcePeer: r.source_peer, count: r.count }))
  }

  async removePeer(url: string): Promise<void> {
    this.stmts.removePeer.run(url)
  }

  async upsertNameRecord(r: Omit<NameRecord, 'modifiedAt'>): Promise<void> {
    this.stmts.ensUpsert.run({
      name:       r.name,
      type:       r.type,
      coinType:   r.coinType,
      textKey:    r.textKey,
      value:      r.value,
      modifiedAt: Math.floor(Date.now() / 1000),
    })
  }

  async deleteNameRecord(name: string, type: string, coinType: number, textKey: string): Promise<void> {
    this.stmts.ensDelete.run({ name, type, coinType, textKey })
  }

  async getNameRecordValue(
    name:     string,
    type:     string,
    coinType: number  = -1,
    textKey:  string  = '',
  ): Promise<string | null> {
    const row = this.stmts.ensGet.get({ name, type, coinType, textKey }) as { value: string } | undefined
    return row?.value ?? null
  }

  async listNameRecords(name?: string): Promise<NameRecord[]> {
    const rows = (name
      ? this.stmts.ensList.all(name)
      : this.stmts.ensListAll.all()) as EnsRow[]
    return rows.map(toNameRecord)
  }

  async insertMessage(msg: Omit<Message, 'id' | 'receivedAt'>): Promise<number> {
    const result = this.stmts.msgInsert.run({
      fromUrl:    msg.fromUrl,
      fromSigner: msg.fromSigner,
      type:       msg.type,
      body:       msg.body,
      version:    msg.version,
      signature:  msg.signature,
      timestamp:  msg.timestamp,
      official:   msg.official ? 1 : 0,
    })
    return result.lastInsertRowid as number
  }

  async getMessages(limit = 50): Promise<Message[]> {
    const rows = this.stmts.msgList.all(limit) as MessageRow[]
    return rows.map(toMessage)
  }

  async markMessagesRead(ids?: number[]): Promise<void> {
    if (!ids || ids.length === 0) {
      this.stmts.msgMarkAllRead.run()
    } else {
      for (const id of ids) this.stmts.msgMarkRead.run(id)
    }
  }

  async unreadMessageCount(): Promise<number> {
    const row = this.stmts.msgUnreadCount.get() as { count: number }
    return row.count
  }

  async blockPeer(url: string): Promise<void> {
    this.stmts.blockPeer.run(url.replace(/\/$/, ''))
  }

  async isBlockedPeer(url: string): Promise<boolean> {
    return !!this.stmts.isBlockedPeer.get(url.replace(/\/$/, ''))
  }

  async upsertJoinRequest(req: Omit<JoinRequest, 'id' | 'createdAt'>): Promise<number> {
    this.stmts.jrUpsert.run({
      url:           req.url,
      signature:     req.signature,
      signerAddress: req.signerAddress,
      status:        req.status,
      healthOk:      req.healthOk ? 1 : 0,
      healthData:    req.healthData ? JSON.stringify(req.healthData) : null,
    })
    const row = this.stmts.jrGetById.get({ signerAddress: req.signerAddress }) as { id: number }
    return row.id
  }

  async getJoinRequests(status?: string): Promise<JoinRequest[]> {
    const rows = (status
      ? this.stmts.jrListStatus.all(status)
      : this.stmts.jrList.all()) as JoinRequestRow[]
    return rows.map(r => ({
      id:            r.id,
      url:           r.url,
      signature:     r.signature,
      signerAddress: r.signer_address,
      status:        r.status as JoinRequest['status'],
      healthOk:      r.health_ok === 1,
      healthData:    r.health_data ? JSON.parse(r.health_data) as Record<string, unknown> : null,
      createdAt:     r.created_at,
    }))
  }

  async updateJoinRequestStatus(id: number, status: 'approved' | 'declined'): Promise<void> {
    this.stmts.jrUpdateStatus.run(status, id)
  }

  async getContributionsWithAddresses(namespace: string): Promise<{ sourcePeer: string | null; count: number; signerAddress: string | null }[]> {
    const rows = this.stmts.contributionsWithAddrs.all(namespace) as { source_peer: string | null; count: number; signer_address: string | null }[]
    return rows.map((r) => ({ sourcePeer: r.source_peer, count: r.count, signerAddress: r.signer_address }))
  }

  async getSnapshot(periodId: number): Promise<SnapshotDbRow | null> {
    const row = this.stmts.snapshotGet.get(periodId) as SnapshotDbRow | undefined
    return row ?? null
  }

  async ensureSnapshot(periodId: number, snapshotCutoff: number): Promise<void> {
    this.stmts.snapshotInsert.run(periodId, snapshotCutoff)
  }

  async freezeSnapshot(
    periodId: number,
    frozenAt: number,
    rowCount: number,
    snapshotRoot: string,
    commitmentHash: string,
    nodeAddress: string,
  ): Promise<void> {
    this.stmts.snapshotFreeze.run({ periodId, frozenAt, rowCount, snapshotRoot, commitmentHash, nodeAddress })
  }

  async updateSnapshotStatus(periodId: number, status: string): Promise<void> {
    this.stmts.snapshotSetStatus.run(status, periodId)
  }

  close(): void {
    this.db.close()
  }
}

// secp256k1 order and its half — for EIP-2 low-s normalization.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SECP256K1_HALF_N = SECP256K1_N >> 1n

// Canonicalize an ECDSA signature to low-s (EIP-2) before it is used as an attestation dedup key.
// ECDSA is malleable: (r, s, v) and (r, n−s, v') recover the same signer over the same message, so
// without this a single attestation could be stored twice (storage-growth / corroboration inflation).
// A non-65-byte signature is returned unchanged — the caller stores what it received.
function canonicalizeSignature(sig: string): string {
  const h = sig.startsWith('0x') ? sig.slice(2) : sig
  if (h.length !== 130) return sig
  const r = h.slice(0, 64)
  let s = BigInt('0x' + h.slice(64, 128))
  let v = parseInt(h.slice(128, 130), 16)
  if (s > SECP256K1_HALF_N) {
    s = SECP256K1_N - s
    v = v === 27 ? 28 : v === 28 ? 27 : v ^ 1
  }
  return '0x' + r + s.toString(16).padStart(64, '0') + v.toString(16).padStart(2, '0')
}

// A record is a signed attestation iff it carries a well-formed, non-empty 65-byte signature.
// Unsigned/dry-run records carry signature "0x" (see mesh/sync.ts) — structurally NOT signed. This is
// structural eligibility only; a companion profile still cryptographically verifies validity over the
// observation and recovers the signer before counting signer weight (V2 / §7.1).
function isSignedAttestation(sig: string): boolean {
  return sig !== '0x' && /^0x[0-9a-f]{130}$/i.test(sig)
}

// The dedup identity of an attestation. Signed → its low-s-canonical signature. Unsigned → a content
// digest over a PINNED preimage of the OBSERVATION (input_hash, namespace, key, value, timestamp) —
// deliberately excluding source_peer and the signature, so transport metadata cannot redefine identity
// and distinct unsigned records do not all collide on "0x" (they would silently dedup away their own
// multiplicity). Never mints signer weight either way; signed-ness is carried separately.
// Canonical serialization the recompute-kit family already gates on: sorted-key UTF-8 JSON + exactly
// one trailing LF. Injective across field boundaries (JSON quotes/escapes each value), unlike delimiter
// concatenation — where ("a|b","c") and ("a","b|c") would hash identically.
function encodeJsonUtf8Lf(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return JSON.stringify(sorted) + '\n'
}

function attestationIdentity(r: MeshRecord): { id: string; signed: number } {
  if (isSignedAttestation(r.signature)) return { id: canonicalizeSignature(r.signature), signed: 1 }
  // Named canonical object, not delimiter concat, so the preimage is injective across field boundaries.
  // source_peer and signature stay OUT of identity (transport metadata must not redefine identity).
  const preimage = encodeJsonUtf8Lf({
    domain: 'ccip.attestation.unsigned.v1',
    input_hash: r.inputHash,
    namespace: r.namespace,
    key: r.key,
    value: r.value,
    timestamp: r.timestamp,
  })
  return { id: 'unsigned:' + createHash('sha256').update(preimage, 'utf8').digest('hex'), signed: 0 }
}

function toMeshRecord(row: RecordRow): MeshRecord {
  return {
    inputHash:  row.input_hash,
    namespace:  row.namespace,
    key:        row.key,
    value:      row.value,
    timestamp:  row.timestamp,
    signature:  row.signature,
    sourcePeer: row.source_peer,
  }
}

function toPeerState(row: PeerRow): PeerState {
  return {
    url:           row.url,
    lastSyncAt:    row.last_sync_at,
    healthy:       row.healthy === 1,
    nodeVersion:   row.node_version,
    signerAddress: row.signer_address,
  }
}

type SnapshotDbRow = {
  period_id:       number
  snapshot_cutoff: number
  frozen_at:       number | null
  row_count:       number | null
  snapshot_root:   string | null
  commitment_hash: string | null
  node_address:    string | null
  status:          'pending' | 'frozen' | 'committed' | 'revealed'
}

type MessageRow = {
  id:          number
  from_url:    string
  from_signer: string
  type:        string
  body:        string
  version:     string
  signature:   string
  timestamp:   number
  received_at: number
  read:        number
  official:    number
}

function toMessage(row: MessageRow): Message {
  return {
    id:         row.id,
    fromUrl:    row.from_url,
    fromSigner: row.from_signer,
    type:       row.type as MessageType,
    body:       row.body,
    version:    row.version,
    signature:  row.signature,
    timestamp:  row.timestamp,
    receivedAt: row.received_at,
    read:       row.read === 1,
    official:   row.official === 1,
  }
}

function toNameRecord(row: EnsRow): NameRecord {
  return {
    name:       row.name,
    type:       row.type as NameRecord['type'],
    coinType:   row.coin_type,
    textKey:    row.text_key,
    value:      row.value,
    modifiedAt: row.modified_at,
  }
}
