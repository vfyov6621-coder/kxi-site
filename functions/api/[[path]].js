/* ═══════════════════════════════════════════════════════════
   kxi chain — backend (Cloudflare Pages Functions + D1, free tier)
   Deploy guide: DEPLOY.md in the repo root.

   endpoints (all same-origin, under /api):
     POST /api/wallet            auth hdr x-kxi-key   — create/heartbeat wallet
     GET  /api/state[?address=]  public               — chain state, blocks, txs, stats
     POST /api/claim             auth                 — submit proof-of-work, credit treasure
     POST /api/transfer          auth                 — on-chain KXI → KXI transfer
     GET  /api/wallet?address=   public               — lookup any wallet
     POST /api/admin             hdr x-kxi-admin      — config / rotate-salt / info

   money model:
     total supply placed at genesis (default 1000 KXI), scattered as
     treasures of TREASURE_KXI (default 0.5). a treasure nonce is any
     12-hex-char nonce with sha256("salt:nonce") starting with
     `difficulty` zero hex chars. server verifies every claim by
     recomputing the hash — mining happens only in the visitor's CPU.
   ═══════════════════════════════════════════════════════════ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-kxi-key, x-kxi-admin',
  'access-control-max-age': '86400'
};

const enc = new TextEncoder();
const hex = (buf) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

const sha256hex = async (s) =>
  hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const addrFromKey = async (K) => '0x' + (await sha256hex('kxi/addr:' + K)).slice(0, 40);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });

const now = () => Date.now();
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{12}$/;

/* ── schema ───────────────────────────────────────────────── */
const DDL = [
  `CREATE TABLE IF NOT EXISTS config (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS wallets (
     address   TEXT PRIMARY KEY,
     auth_key  TEXT NOT NULL UNIQUE,
     balance   INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     last_seen  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS claims (
     nonce  TEXT PRIMARY KEY,
     hash   TEXT NOT NULL,
     wallet TEXT NOT NULL,
     ts     INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS txs (
     id       TEXT PRIMARY KEY,
     kind     TEXT NOT NULL,
     src      TEXT NOT NULL,
     dst      TEXT NOT NULL,
     amount   INTEGER NOT NULL,
     memo     TEXT,
     block_id INTEGER,
     ts       INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS blocks (
     height   INTEGER PRIMARY KEY,
     prev_hash TEXT NOT NULL,
     tx_root  TEXT NOT NULL,
     hash     TEXT NOT NULL,
     ts       INTEGER NOT NULL,
     tx_count INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_txs_ts ON txs (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_txs_block ON txs (block_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wallets_seen ON wallets (last_seen)`,
  `CREATE INDEX IF NOT EXISTS idx_claims_wallet ON claims (wallet, ts)`
];

let schemaPromise = null;
function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db.batch(DDL.map((sql) => db.prepare(sql))).catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

/* ── genesis / config ─────────────────────────────────────── */

async function readConfig(db) {
  const rows = (await db.prepare(`SELECT k, v FROM config`).all()).results || [];
  const cfg = {};
  for (const r of rows) cfg[r.k] = r.v;
  return cfg;
}

/* config is re-read from D1 on every request (no isolate cache) so that
   admin difficulty/salt retargets apply everywhere within one poll cycle */
async function ensureGenesis(db, env) {
  let existing = await readConfig(db);
  const defaults = {
    total_supply_milli: String(Math.round(parseFloat(env.TOTAL_SUPPLY_KXI || '1000') * 1000) || 1000000),
    treasure_milli: String(Math.round(parseFloat(env.TREASURE_KXI || '0.5') * 1000) || 500),
    difficulty: String(Math.max(1, Math.min(8, parseInt(env.DIFFICULTY || '7', 10) || 7))),
    salt: env.SALT && /^[0-9a-f]{16,64}$/.test(env.SALT) ? env.SALT : hex(crypto.getRandomValues(new Uint8Array(16)))
  };
  const missing = Object.keys(defaults)
    .filter((k) => !existing[k])
    .map((k) => db.prepare(`INSERT OR IGNORE INTO config (k, v) VALUES (?, ?)`).bind(k, defaults[k]));
  if (missing.length) {
    missing.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO blocks (height, prev_hash, tx_root, hash, ts, tx_count)
           VALUES (0, 'GENESIS', 'GENESIS', ?, ?, 0)`
        )
        .bind(await sha256hex('kxi:genesis'), now())
    );
    await db.batch(missing);
    existing = await readConfig(db);
  }
  return {
    salt: existing.salt,
    difficulty: parseInt(existing.difficulty, 10),
    treasureMilli: parseInt(existing.treasure_milli, 10),
    totalSupplyMilli: parseInt(existing.total_supply_milli, 10)
  };
}

/* ── auth ─────────────────────────────────────────────────── */
async function authWallet(request, db) {
  const K = (request.headers.get('x-kxi-key') || '').toLowerCase();
  if (!KEY_RE.test(K)) return { error: json({ ok: false, error: 'bad or missing x-kxi-key header' }, 401) };
  const address = await addrFromKey(K);
  const row = await db
    .prepare(`SELECT address, balance FROM wallets WHERE auth_key = ?`)
    .bind(K)
    .first();
  if (!row) return { error: json({ ok: false, error: 'unknown wallet — open the site first' }, 401) };
  if (row.address !== address) return { error: json({ ok: false, error: 'key mismatch' }, 401) };
  return { address, K, balance: row.balance };
}

/* ── block sealing (best effort, called after writes) ─────── */
async function sealMaybe(db) {
  try {
    const pend =
      (await db.prepare(`SELECT id, ts FROM txs WHERE block_id IS NULL ORDER BY ts LIMIT 17`).all())
        .results || [];
    if (!pend.length) return;
    const t = now();
    if (!(pend.length >= 8 || t - pend[0].ts > 60000)) return;
    const last = await db.prepare(`SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1`).first();
    const height = (last ? last.height : -1) + 1;
    const prevHash = last ? last.hash : 'GENESIS';
    const ids = pend.map((x) => x.id);
    const txRoot = await sha256hex(ids.join('|'));
    const hash = await sha256hex(`${height}|${prevHash}|${txRoot}|${t}`);
    await db.batch([
      db
        .prepare(`INSERT INTO blocks (height, prev_hash, tx_root, hash, ts, tx_count) VALUES (?,?,?,?,?,?)`)
        .bind(height, prevHash, txRoot, hash, t, ids.length),
      db
        .prepare(`UPDATE txs SET block_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(height, ...ids)
    ]);
  } catch (e) {
    /* sealing is best effort — never fail the tx because of it */
  }
}

/* ── handlers ─────────────────────────────────────────────── */
async function handleWalletCreate(request, env, db) {
  const K = (request.headers.get('x-kxi-key') || '').toLowerCase();
  if (!KEY_RE.test(K)) return json({ ok: false, error: 'bad or missing x-kxi-key header' }, 401);
  const address = await addrFromKey(K);
  const t = now();
  const row = await db
    .prepare(`SELECT address, balance, created_at FROM wallets WHERE auth_key = ?`)
    .bind(K)
    .first();
  if (row) {
    if (row.address !== address) return json({ ok: false, error: 'key mismatch' }, 401);
    await db.prepare(`UPDATE wallets SET last_seen = ? WHERE address = ?`).bind(t, address).run();
    return json({
      ok: true,
      wallet: { address, balanceKxi: row.balance / 1000, createdAt: row.created_at, isNew: false }
    });
  }
  try {
    await db
      .prepare(`INSERT INTO wallets (address, auth_key, balance, created_at, last_seen) VALUES (?,?,0,?,?)`)
      .bind(address, K, t, t)
      .run();
  } catch (e) {
    return json({ ok: false, error: 'wallet conflict — address already exists with another key' }, 409);
  }
  return json({
    ok: true,
    wallet: { address, balanceKxi: 0, createdAt: t, isNew: true }
  });
}

async function handleState(request, env, db) {
  const cfg = await ensureGenesis(db, env);
  const url = new URL(request.url);
  const addr = (url.searchParams.get('address') || '').toLowerCase();
  const t = now();

  const chain =
    (await db
      .prepare(
        `SELECT
           (SELECT COALESCE(MAX(height), 0) FROM blocks) AS height,
           (SELECT COALESCE(SUM(amount), 0) FROM txs WHERE kind = 'claim') AS mined,
           (SELECT COUNT(*) FROM claims) AS found,
           (SELECT COUNT(*) FROM wallets) AS wallets,
           (SELECT COUNT(*) FROM wallets WHERE last_seen > ?) AS hunters,
           (SELECT COUNT(*) FROM txs) AS txs,
           (SELECT COUNT(*) FROM txs WHERE block_id IS NULL) AS pending`
      )
      .bind(t - 90000)
      .first()) || {};

  const blocks =
    (await db
      .prepare(`SELECT height, hash, tx_count, ts FROM blocks ORDER BY height DESC LIMIT 9`)
      .all()).results || [];

  const txs =
    (await db
      .prepare(
        `SELECT id, kind, src, dst, amount, memo, ts, block_id
         FROM txs ORDER BY ts DESC LIMIT 9`
      )
      .all()).results || [];

  let wallet = null;
  if (ADDR_RE.test(addr)) {
    const w = await db
      .prepare(`SELECT address, balance, created_at FROM wallets WHERE address = ?`)
      .bind(addr)
      .first();
    const wt =
      (await db
        .prepare(
          `SELECT id, kind, src, dst, amount, memo, ts, block_id
           FROM txs WHERE src = ? OR dst = ? ORDER BY ts DESC LIMIT 6`
        )
        .bind(addr, addr)
        .all()).results || [];
    wallet = {
      address: addr,
      exists: !!w,
      balanceKxi: w ? w.balance / 1000 : 0,
      txs: wt.map(mapTx)
    };
  }

  const minedMilli = chain.mined || 0;
  const treasureMilli = cfg.treasureMilli;
  return json({
    ok: true,
    chain: {
      height: chain.height || 0,
      salt: cfg.salt,
      difficulty: cfg.difficulty,
      target: '0x' + '0'.repeat(cfg.difficulty),
      treasureKxi: treasureMilli / 1000,
      totalSupplyKxi: cfg.totalSupplyMilli / 1000,
      minedKxi: minedMilli / 1000,
      remainingKxi: Math.max(0, (cfg.totalSupplyMilli - minedMilli) / 1000),
      treasuresFound: chain.found || 0,
      treasuresTotal: Math.floor(cfg.totalSupplyMilli / treasureMilli)
    },
    net: {
      huntersOnline: chain.hunters || 0,
      walletsTotal: chain.wallets || 0,
      txsTotal: chain.txs || 0,
      pendingTxs: chain.pending || 0
    },
    blocks: blocks.map((b) => ({
      height: b.height,
      hash: b.hash,
      txCount: b.tx_count,
      ts: b.ts
    })),
    txs: txs.map(mapTx),
    wallet
  });
}

function mapTx(t) {
  return {
    id: t.id,
    kind: t.kind,
    src: t.src,
    dst: t.dst,
    amountKxi: t.amount / 1000,
    memo: t.memo || null,
    ts: t.ts,
    block: t.block_id === null ? null : t.block_id
  };
}

async function handleWalletLookup(url, env, db) {
  const addr = (url.searchParams.get('address') || '').toLowerCase();
  if (!ADDR_RE.test(addr)) return json({ ok: false, error: 'bad address' }, 400);
  const w = await db
    .prepare(`SELECT address, balance, created_at, last_seen FROM wallets WHERE address = ?`)
    .bind(addr)
    .first();
  if (!w) return json({ ok: false, error: 'wallet not found' }, 404);
  const txs =
    (await db
      .prepare(
        `SELECT id, kind, src, dst, amount, memo, ts, block_id
         FROM txs WHERE src = ? OR dst = ? ORDER BY ts DESC LIMIT 5`
      )
      .bind(addr, addr)
      .all()).results || [];
  return json({
    ok: true,
    wallet: {
      address: w.address,
      balanceKxi: w.balance / 1000,
      createdAt: w.created_at,
      lastSeen: w.last_seen
    },
    txs: txs.map(mapTx)
  });
}

async function handleClaim(request, env, db) {
  const cfg = await ensureGenesis(db, env);
  const auth = await authWallet(request, db);
  if (auth.error) return auth.error;

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'bad json body' }, 400);
  }
  const nonce = String(body.nonce || '').toLowerCase();
  if (!NONCE_RE.test(nonce)) return json({ ok: false, error: 'bad nonce — expected 12 hex chars' }, 400);

  const h = await sha256hex(`${cfg.salt}:${nonce}`);
  if (!h.startsWith('0'.repeat(cfg.difficulty)))
    return json({ ok: false, reason: 'invalid', error: 'proof rejected — hash does not meet target' }, 400);

  const stats =
    (await db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(amount), 0) FROM txs WHERE kind = 'claim') AS mined,
           (SELECT 1 FROM claims WHERE nonce = ?) AS taken,
           (SELECT MAX(ts) FROM claims WHERE wallet = ?) AS lastTs`
      )
      .bind(nonce, auth.address)
      .first()) || {};

  if (stats.taken) return json({ ok: false, reason: 'taken', error: 'nonce already claimed' }, 409);
  const t = now();
  if (stats.lastTs && t - stats.lastTs < 250)
    return json({ ok: false, reason: 'fast', error: 'too many claims — slow down' }, 429);
  const minedMilli = stats.mined || 0;
  const remainingMilli = cfg.totalSupplyMilli - minedMilli;
  if (remainingMilli < cfg.treasureMilli)
    return json({ ok: false, reason: 'empty', error: 'chain drained — all coins found' }, 410);

  const txId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(`INSERT INTO claims (nonce, hash, wallet, ts) VALUES (?,?,?,?)`).bind(nonce, h, auth.address, t),
      db
        .prepare(
          `INSERT INTO txs (id, kind, src, dst, amount, memo, block_id, ts)
           VALUES (?, 'claim', 'COINBASE', ?, ?, NULL, NULL, ?)`
        )
        .bind(txId, auth.address, cfg.treasureMilli, t),
      db
        .prepare(`UPDATE wallets SET balance = balance + ?, last_seen = ? WHERE address = ?`)
        .bind(cfg.treasureMilli, t, auth.address)
    ]);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/UNIQUE|PRIMARY KEY/i.test(msg)) return json({ ok: false, reason: 'taken', error: 'nonce already claimed' }, 409);
    throw e;
  }

  const w = await db.prepare(`SELECT balance FROM wallets WHERE address = ?`).bind(auth.address).first();
  await sealMaybe(db);
  return json({
    ok: true,
    txId,
    nonce,
    hash: h,
    creditedKxi: cfg.treasureMilli / 1000,
    balanceKxi: w ? w.balance / 1000 : 0,
    remainingKxi: Math.max(0, (remainingMilli - cfg.treasureMilli) / 1000)
  });
}

async function handleTransfer(request, env, db) {
  await ensureGenesis(db, env);
  const auth = await authWallet(request, db);
  if (auth.error) return auth.error;

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'bad json body' }, 400);
  }
  const to = String(body.to || '').toLowerCase().trim();
  if (!ADDR_RE.test(to)) return json({ ok: false, reason: 'badto', error: 'bad recipient address — expected 0x + 40 hex' }, 400);
  if (to === auth.address) return json({ ok: false, reason: 'self', error: 'self-transfer rejected' }, 400);

  const amount = Number(body.amount);
  if (!isFinite(amount) || amount <= 0)
    return json({ ok: false, reason: 'badamt', error: 'bad amount' }, 400);
  const amountMilli = Math.round(amount * 1000);
  if (amountMilli <= 0) return json({ ok: false, reason: 'badamt', error: 'amount too small — min 0.001 KXI' }, 400);

  if (auth.balance < amountMilli)
    return json({ ok: false, reason: 'funds', error: `insufficient balance — you have ${(auth.balance / 1000).toFixed(3)} KXI` }, 400);

  const recipient = await db.prepare(`SELECT address FROM wallets WHERE address = ?`).bind(to).first();
  if (!recipient)
    return json({ ok: false, reason: 'nokey', error: 'recipient wallet not found — they must open the site first (auto-wallet)' }, 404);

  const memo = String(body.memo || '').slice(0, 120);
  const txId = crypto.randomUUID();
  const t = now();

  /* guarded writes in ONE batch (= single transaction):
     all guards read the pre-debit sender balance; the debit runs last,
     so either everything applies or everything no-ops */
  const results = await db.batch([
    db
      .prepare(
        `UPDATE wallets SET balance = balance + ?, last_seen = ? WHERE address = ?
         AND EXISTS (SELECT 1 FROM wallets WHERE address = ? AND balance >= ?)`
      )
      .bind(amountMilli, t, to, auth.address, amountMilli),
    db
      .prepare(
        `INSERT INTO txs (id, kind, src, dst, amount, memo, block_id, ts)
         SELECT ?, 'transfer', ?, ?, ?, ?, NULL, ?
         WHERE EXISTS (SELECT 1 FROM wallets WHERE address = ? AND balance >= ?)`
      )
      .bind(txId, auth.address, to, amountMilli, memo, t, auth.address, amountMilli),
    db
      .prepare(`UPDATE wallets SET balance = balance - ?, last_seen = ? WHERE address = ? AND balance >= ?`)
      .bind(amountMilli, t, auth.address, amountMilli)
  ]);

  if (!results || !results[1] || (results[1].meta && results[1].meta.changes === 0)) {
    return json({ ok: false, reason: 'funds', error: 'insufficient balance (concurrent spend?)' }, 400);
  }

  const w = await db.prepare(`SELECT balance FROM wallets WHERE address = ?`).bind(auth.address).first();
  await sealMaybe(db);
  return json({
    ok: true,
    txId,
    to,
    amountKxi: amountMilli / 1000,
    balanceKxi: w ? w.balance / 1000 : 0
  });
}

async function handleAdmin(request, env, db) {
  const key = request.headers.get('x-kxi-admin') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'forbidden' }, 403);

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'bad json body' }, 400);
  }
  const cfg = await ensureGenesis(db, env);
  const t = now();

  if (body.action === 'info') {
    const mined = (await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM txs WHERE kind = 'claim'`).first()).s || 0;
    return json({
      ok: true,
      config: {
        salt: cfg.salt,
        difficulty: cfg.difficulty,
        treasureKxi: cfg.treasureMilli / 1000,
        totalSupplyKxi: cfg.totalSupplyMilli / 1000,
        minedKxi: mined / 1000,
        remainingKxi: Math.max(0, (cfg.totalSupplyMilli - mined) / 1000)
      }
    });
  }

  if (body.action === 'rotate-salt') {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await db.prepare(`INSERT OR REPLACE INTO config (k, v) VALUES ('salt', ?)`).bind(salt).run();
    return json({ ok: true, salt });
  }

  if (body.action === 'config') {
    const updates = [];
    const next = { ...cfg };
    if (body.treasureKxi !== undefined) {
      const m = Math.round(Number(body.treasureKxi) * 1000);
      if (!isFinite(m) || m <= 0) return json({ ok: false, error: 'bad treasureKxi' }, 400);
      updates.push(db.prepare(`INSERT OR REPLACE INTO config (k, v) VALUES ('treasure_milli', ?)`).bind(String(m)));
      next.treasureMilli = m;
    }
    if (body.difficulty !== undefined) {
      const d = parseInt(body.difficulty, 10);
      if (!(d >= 1 && d <= 8)) return json({ ok: false, error: 'difficulty must be 1..8' }, 400);
      updates.push(db.prepare(`INSERT OR REPLACE INTO config (k, v) VALUES ('difficulty', ?)`).bind(String(d)));
      next.difficulty = d;
    }
    if (body.totalSupplyKxi !== undefined) {
      const mined = (await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM txs WHERE kind = 'claim'`).first()).s || 0;
      const m = Math.round(Number(body.totalSupplyKxi) * 1000);
      if (!isFinite(m) || m < mined)
        return json({ ok: false, error: `bad totalSupplyKxi — already mined ${mined / 1000}` }, 400);
      updates.push(db.prepare(`INSERT OR REPLACE INTO config (k, v) VALUES ('total_supply_milli', ?)`).bind(String(m)));
      next.totalSupplyMilli = m;
    }
    if (!updates.length)
      return json({ ok: false, error: 'nothing to update — pass treasureKxi / difficulty / totalSupplyKxi' }, 400);
    updates.push(db.prepare(`INSERT OR REPLACE INTO config (k, v) VALUES ('updated_at', ?)`).bind(String(t)));
    await db.batch(updates);
    return json({
      ok: true,
      config: {
        difficulty: next.difficulty,
        treasureKxi: next.treasureMilli / 1000,
        totalSupplyKxi: next.totalSupplyMilli / 1000
      }
    });
  }

  return json({ ok: false, error: 'unknown action — use info | config | rotate-salt' }, 400);
}

/* ── router ───────────────────────────────────────────────── */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const route = `${request.method} ${path}`;

  try {
    if (!env || !env.DB)
      return json({ ok: false, error: 'D1 database not bound — attach binding "DB" (see DEPLOY.md)' }, 500);
    await ensureSchema(env.DB);

    switch (route) {
      case 'GET':
      case 'GET ':
        return json({
          ok: true,
          chain: 'kxi',
          endpoints: ['POST /api/wallet', 'GET /api/state', 'POST /api/claim', 'POST /api/transfer', 'GET /api/wallet?address=', 'POST /api/admin']
        });
      case 'POST wallet':
        return await handleWalletCreate(request, env, env.DB);
      case 'GET state':
        return await handleState(request, env, env.DB);
      case 'GET wallet':
        return await handleWalletLookup(url, env, env.DB);
      case 'POST claim':
        return await handleClaim(request, env, env.DB);
      case 'POST transfer':
        return await handleTransfer(request, env, env.DB);
      case 'POST admin':
        return await handleAdmin(request, env, env.DB);
      default:
        return json({ ok: false, error: 'not found' }, 404);
    }
  } catch (e) {
    return json({ ok: false, error: 'internal: ' + String((e && e.message) || e) }, 500);
  }
}
