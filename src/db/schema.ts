// schema_version tracks applied migrations.
// Run SCHEMA first (creates the version table if missing), then runMigrations().
export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version  INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS peers (
    url             TEXT    PRIMARY KEY,
    last_sync_at    INTEGER NOT NULL DEFAULT 0,
    healthy         INTEGER NOT NULL DEFAULT 1,
    node_version    TEXT,
    signer_address  TEXT
  );
`

// Ordered migrations — each runs exactly once, gated by schema_version.
// v1: composite PK (input_hash, namespace) replaces single-column input_hash PK,
//     allowing WYRIWE attestation records to coexist with basic records
//     for the same calldata in a different namespace.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      DROP TABLE IF EXISTS records;
      CREATE TABLE records (
        input_hash  TEXT    NOT NULL,
        namespace   TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        value       TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        signature   TEXT    NOT NULL,
        source_peer TEXT,
        PRIMARY KEY (input_hash, namespace)
      );
      CREATE INDEX IF NOT EXISTS idx_records_ns_ts
        ON records (namespace, timestamp);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS ens_records (
        name        TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        coin_type   INTEGER NOT NULL DEFAULT -1,
        text_key    TEXT    NOT NULL DEFAULT '',
        value       TEXT    NOT NULL,
        modified_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (name, type, coin_type, text_key)
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        from_url    TEXT    NOT NULL,
        from_signer TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        body        TEXT    NOT NULL,
        version     TEXT    NOT NULL DEFAULT '',
        signature   TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        received_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        read        INTEGER NOT NULL DEFAULT 0,
        official    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_read ON messages (read);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS join_requests (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        url            TEXT    NOT NULL,
        signature      TEXT    NOT NULL,
        signer_address TEXT    NOT NULL,
        status         TEXT    NOT NULL DEFAULT 'pending',
        health_ok      INTEGER NOT NULL DEFAULT 0,
        health_data    TEXT,
        created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(signer_address)
      );
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS peer_blocklist (
        url        TEXT    PRIMARY KEY,
        blocked_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS snapshots (
        period_id       INTEGER PRIMARY KEY,
        snapshot_cutoff INTEGER NOT NULL DEFAULT 0,
        frozen_at       INTEGER,
        row_count       INTEGER,
        snapshot_root   TEXT,
        commitment_hash TEXT,
        node_address    TEXT,
        status          TEXT    NOT NULL DEFAULT 'pending'
      );
    `,
  },
  {
    // ERC-8309 divergence preservation: same (input_hash, namespace) with a
    // DIFFERING value is a first-class divergence, not a duplicate. Observation
    // identity is (input_hash, namespace, value); signature, timestamp and
    // source_peer are attestation metadata OUTSIDE identity. Widening the PK to
    // include value keeps INSERT OR IGNORE an observation-identical no-op (same
    // value collapses even from different signers) while letting two honest,
    // differing observations coexist instead of the second being silently
    // dropped. Divergence must be preserved by the data model — it is upstream
    // of every consumer's view.
    // NOTE (quorum deferral): collapsing same-value/different-peer to one row
    // discards attestation multiplicity. Value-divergence is preserved; per-value
    // corroboration counts (needed by a quorum profile) are NOT retained by this
    // base and are a declared extension — see the §Deduplication amendment note.
    version: 7,
    sql: `
      ALTER TABLE records RENAME TO records_legacy;
      CREATE TABLE records (
        input_hash  TEXT    NOT NULL,
        namespace   TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        value       TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        signature   TEXT    NOT NULL,
        source_peer TEXT,
        PRIMARY KEY (input_hash, namespace, value)
      );
      INSERT OR IGNORE INTO records
        SELECT input_hash, namespace, key, value, timestamp, signature, source_peer
        FROM records_legacy;
      DROP TABLE records_legacy;
      CREATE INDEX IF NOT EXISTS idx_records_ns_ts ON records (namespace, timestamp);
    `,
  },
]