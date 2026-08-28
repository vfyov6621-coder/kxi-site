-- kxi chain — D1 schema (reference)
-- Tables are created automatically by the backend on first request
-- (functions/api/[[path]].js → ensureSchema). This file is documentation
-- plus a manual reset tool for the D1 console (see DEPLOY.md).

CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  address    TEXT PRIMARY KEY,          -- 0x + 40 hex
  auth_key   TEXT NOT NULL UNIQUE,      -- sha256("kxi/auth:" + secret), held by browser
  balance    INTEGER NOT NULL DEFAULT 0,-- milli-KXI (0.001)
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  nonce  TEXT PRIMARY KEY,              -- 12 hex chars
  hash   TEXT NOT NULL,                 -- sha256(salt:nonce), verified server-side
  wallet TEXT NOT NULL,
  ts     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS txs (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,               -- 'claim' | 'transfer'
  src      TEXT NOT NULL,               -- wallet or 'COINBASE'
  dst      TEXT NOT NULL,
  amount   INTEGER NOT NULL,            -- milli-KXI
  memo     TEXT,
  block_id INTEGER,                     -- NULL = pending
  ts       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  height    INTEGER PRIMARY KEY,
  prev_hash TEXT NOT NULL,
  tx_root   TEXT NOT NULL,
  hash      TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  tx_count  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_txs_ts ON txs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_txs_block ON txs (block_id);
CREATE INDEX IF NOT EXISTS idx_wallets_seen ON wallets (last_seen);
CREATE INDEX IF NOT EXISTS idx_claims_wallet ON claims (wallet, ts);

-- Full chain reset (D1 console):
--   DELETE FROM claims; DELETE FROM txs; DELETE FROM blocks;
--   DELETE FROM wallets; DELETE FROM config;
-- Chain re-genesis from env vars on the next request.
