// DB interface — implementation (SQLite) lives in db/sqlite.ts
// CcipRouter depends on this interface, not the implementation.
// Swap the implementation without touching router logic.

export type MeshRecord = {
  inputHash: string    // primary key — keccak256 of input, hex
  namespace: string
  key: string
  value: string
  timestamp: number
  signature: string
  sourcePeer: string | null  // null = produced locally
}

// ERC-8309 record-store state for one (inputHash, namespace). Divergence is a
// first-class outcome — never a silent drop, never folded into agreement.
export type RecordState =
  | { state: 'absent' }
  | { state: 'single'; record: MeshRecord }
  | { state: 'divergent'; records: MeshRecord[] }  // committed attestation set, enumerated

export type PeerState = {
  url: string
  lastSyncAt: number
  healthy: boolean
  nodeVersion: string | null
  signerAddress: string | null  // recovered from signed records during sync
}

export type Contribution = {
  sourcePeer: string | null   // null = produced locally
  count:      number
}

export type JoinRequest = {
  id:            number
  url:           string
  signature:     string
  signerAddress: string
  status:        'pending' | 'approved' | 'declined'
  healthOk:      boolean
  healthData:    Record<string, unknown> | null
  createdAt:     number
}

export type MessageType = 'upgrade_notice' | 'deprecation' | 'network_announcement'

export type Message = {
  id:          number
  fromUrl:     string
  fromSigner:  string
  type:        MessageType
  body:        string
  version:     string
  signature:   string
  timestamp:   number
  receivedAt:  number
  read:        boolean
  official:    boolean
}

export type NameRecord = {
  name:       string
  type:       'addr' | 'addr_coin' | 'text' | 'contenthash'
  coinType:   number    // -1 when not applicable
  textKey:    string    // '' when not applicable
  value:      string
  modifiedAt: number
}

export interface DB {
  insertRecord(record: MeshRecord): Promise<void>
  getRecordsSince(namespace: string, since: number, limit: number, cursor?: string): Promise<MeshRecord[]>
  getRecord(inputHash: string, namespace?: string): Promise<MeshRecord | null>
  getRecordsByInputHash(inputHash: string): Promise<MeshRecord[]>
  getRecordState(inputHash: string, namespace: string): Promise<RecordState>
  getRecentRecords(namespace: string, limit: number): Promise<MeshRecord[]>
  getContributions(namespace: string): Promise<Contribution[]>
  upsertPeer(peer: PeerState): Promise<void>
  removePeer(url: string): Promise<void>
  blockPeer(url: string): Promise<void>
  isBlockedPeer(url: string): Promise<boolean>
  getPeers(): Promise<PeerState[]>
  recordCount(namespace: string): Promise<number>
  ensNameCount(): Promise<number>
  // Mesh messages — signed push notifications from peers
  insertMessage(msg: Omit<Message, 'id' | 'receivedAt'>): Promise<number>
  getMessages(limit?: number): Promise<Message[]>
  markMessagesRead(ids?: number[]): Promise<void>
  unreadMessageCount(): Promise<number>
  // ENS name records — admin-managed, served via withEns()
  upsertNameRecord(r: Omit<NameRecord, 'modifiedAt'>): Promise<void>
  deleteNameRecord(name: string, type: string, coinType: number, textKey: string): Promise<void>
  getNameRecordValue(name: string, type: string, coinType?: number, textKey?: string): Promise<string | null>
  listNameRecords(name?: string): Promise<NameRecord[]>
  // Join requests — soft governance for new node onboarding
  upsertJoinRequest(req: Omit<JoinRequest, 'id' | 'createdAt'>): Promise<number>
  getJoinRequests(status?: string): Promise<JoinRequest[]>
  updateJoinRequestStatus(id: number, status: 'approved' | 'declined'): Promise<void>
  // ERC-8275 Layer 2 — contribution snapshots
  getContributionsWithAddresses(namespace: string): Promise<{ sourcePeer: string | null; count: number; signerAddress: string | null }[]>
  getSnapshot(periodId: number): Promise<{ period_id: number; snapshot_cutoff: number; frozen_at: number | null; row_count: number | null; snapshot_root: string | null; commitment_hash: string | null; node_address: string | null; status: string } | null>
  ensureSnapshot(periodId: number, snapshotCutoff: number): Promise<void>
  freezeSnapshot(periodId: number, frozenAt: number, rowCount: number, snapshotRoot: string, commitmentHash: string, nodeAddress: string): Promise<void>
  updateSnapshotStatus(periodId: number, status: string): Promise<void>
  close(): void
}
