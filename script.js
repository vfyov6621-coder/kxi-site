/* ═══════════════════════════════════════════════════════════
   kxi — find the token in the chaos
   auto wallet · local mining (workers) · on-chain transfers · live explorer
   backend: same-origin /api (Cloudflare Pages Functions + D1) — see DEPLOY.md
   ═══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ---------- utils ---------- */
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const fmt = (n, d = 0) =>
    Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const short = (h) => String(h).slice(0, 10) + '…' + String(h).slice(-6);
  const pad = (n, l) => String(n).padStart(l, '0');
  const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

  const sha256Hex = async (s) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  /* ---------- odometer ---------- */
  class Odo {
    constructor(el, val, f = (v) => fmt(Math.round(v))) {
      this.el = el;
      this.val = val;
      this.cur = val;
      this.f = f;
      this.raf = null;
      el.textContent = f(val);
    }
    set(v) {
      this.val = v;
      if (REDUCED) {
        this.cur = v;
        this.el.textContent = this.f(v);
        return;
      }
      if (this.raf === null) this.tick();
    }
    tick() {
      this.raf = requestAnimationFrame(() => {
        const d = this.val - this.cur;
        if (Math.abs(d) < 0.01 * Math.max(1, Math.abs(this.val))) {
          this.cur = this.val;
          this.el.textContent = this.f(this.val);
          this.raf = null;
          return;
        }
        this.cur += d * 0.14;
        this.el.textContent = this.f(this.cur);
        this.tick();
      });
    }
  }

  /* ---------- terminal ---------- */
  const termBody = $('#terminalBody');
  const TERM_MAX = 90;
  function tline(text, cls) {
    const el = document.createElement('div');
    el.className = 't-line' + (cls ? ' ' + cls : '');
    el.textContent = text;
    termBody.appendChild(el);
    while (termBody.children.length > TERM_MAX) termBody.removeChild(termBody.firstChild);
    termBody.scrollTop = termBody.scrollHeight;
  }

  /* ---------- API layer ---------- */
  /* Backend base, resolved at boot:
     1. same-origin /api (frontend+backend deployed together, local dev server)
     2. the public chain backend URL (GitHub Pages case) — CORS * there */
  const BACKEND = 'https://kxi-chain.pages.dev';
  let API = null;

  async function resolveApi() {
    if (API) return API;
    try {
      const probe = fetch(location.origin + '/api/state', { method: 'GET' });
      const timed = await Promise.race([
        probe.then((r) => (r.ok ? r.json() : null)),
        new Promise((res) => setTimeout(() => res(null), 4000))
      ]);
      if (timed && timed.ok) {
        API = '/api';
        return API;
      }
    } catch (e) {
      /* same-origin api absent — use the public backend */
    }
    API = BACKEND + '/api';
    return API;
  }
  let chainOnline = null; // null = booting, true, false
  let state = null;       // last /api/state payload

  async function api(path, opts = {}) {
    const base = await resolveApi();
    const headers = { 'content-type': 'application/json' };
    if (wallet.authKey) headers['x-kxi-key'] = wallet.authKey;
    let res;
    try {
      res = await fetch(base + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw { network: true, error: 'fetch failed' };
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      data = { ok: false, error: 'non-json response' };
    }
    data.__status = res.status;
    return data;
  }

  /* ---------- wallet (auto-issued in this browser) ---------- */
  const LS_KEY = 'kxi.wallet.v1';
  const wallet = { secret: null, address: null, authKey: null, isNew: false };

  async function derive(secret) {
    const authKey = await sha256Hex('kxi/auth:' + secret);
    const address = '0x' + (await sha256Hex('kxi/addr:' + authKey)).slice(0, 40);
    return { authKey, address };
  }

  function randomSecret() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function saveWallet() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ secret: wallet.secret, address: wallet.address }));
    } catch (e) {
      /* private mode — wallet lives only in RAM this session */
    }
  }

  function loadWallet() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const w = JSON.parse(raw);
      if (typeof w.secret === 'string' && /^[0-9a-f]{64}$/.test(w.secret)) return w;
    } catch (e) {
      /* corrupted — fall through to fresh wallet */
    }
    return null;
  }

  async function initWallet() {
    const stored = loadWallet();
    if (stored) {
      const d = await derive(stored.secret);
      if (d.address === stored.address) {
        wallet.secret = stored.secret;
        wallet.address = d.address;
        wallet.authKey = d.authKey;
        return;
      }
      /* stored address inconsistent with key — regenerate */
    }
    wallet.secret = randomSecret();
    const d = await derive(wallet.secret);
    wallet.address = d.address;
    wallet.authKey = d.authKey;
    wallet.isNew = true;
    saveWallet();
  }

  async function registerWallet() {
    try {
      const r = await api('/wallet', { method: 'POST' });
      if (r.ok) {
        setOnline(true);
        return r;
      }
      if (r.__status === 401) {
        /* key conflicts with stored state — wipe and mint a fresh one */
        tline('wallet key rejected — minting a new wallet', 't-err');
        localStorage.removeItem(LS_KEY);
        wallet.secret = randomSecret();
        const d = await derive(wallet.secret);
        wallet.address = d.address;
        wallet.authKey = d.authKey;
        saveWallet();
        return await api('/wallet', { method: 'POST' });
      }
      setOnline(false);
      return r;
    } catch (e) {
      setOnline(false);
      return { ok: false, network: true };
    }
  }

  /* ---------- online / offline ---------- */
  const offlineBar = $('#offlineBar');
  const startBtn = $('#startBtn');
  const sendBtn = $('#sendBtn');
  const statusValue = $('#statusValue');

  function setOnline(v) {
    if (chainOnline === v) return;
    chainOnline = v;
    if (v) {
      offlineBar.hidden = true;
      startBtn.disabled = false;
      sendBtn.disabled = false;
      if (statusValue.textContent === 'OFFLINE' || statusValue.textContent === 'BOOTING')
        statusValue.textContent = miner.running ? 'SEARCHING_' : 'IDLE';
    } else {
      offlineBar.hidden = false;
      startBtn.disabled = true;
      sendBtn.disabled = true;
      if (!miner.running) statusValue.textContent = 'OFFLINE';
      $('#blocksBody').innerHTML = '<tr><td class="td-dim" colspan="4">awaiting chain connection…</td></tr>';
      $('#txsBody').innerHTML = '<tr><td class="td-dim" colspan="6">awaiting chain connection…</td></tr>';
    }
  }

  /* ---------- hero stats ---------- */
  const oBlock = new Odo($('#statBlock'), 0);
  const oRemain = new Odo($('#statRemain'), 0, (v) => fmt(v, 1));
  const oFound = new Odo($('#statFound'), 0);
  const oHunters = new Odo($('#statHunters'), 0);
  const oRate = new Odo($('#statRate'), 0, (v) => fmt(v, 0) + ' kH/s');

  /* ---------- mining (local brute force via Web Workers) ---------- */
  const miner = {
    workers: [],
    running: false,
    threads: 0,
    hashes: 0,
    hps: 0,
    sessionFinds: 0,
    params: { salt: null, difficulty: null },
    lastProbe: null
  };
  const mHashrate = $('#mHashrate');
  const mTotal = $('#mTotal');
  const mFound = $('#mFound');
  const threadCount = $('#threadCount');

  function pickThreads() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (coarse) return 1;
    return Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  }

  function startMining() {
    if (miner.running || !state || !state.ok) return;
    const { salt, difficulty } = state.chain;
    miner.params = { salt, difficulty };
    miner.threads = pickThreads();
    miner.workers = [];
    miner.hashes = 0;
    miner.hps = 0;
    for (let i = 0; i < miner.threads; i++) {
      const w = new Worker('miner.js');
      w.onmessage = (ev) => onWorkerMessage(ev.data);
      w.onerror = () => tline('worker error — thread dropped', 't-err');
      w.postMessage({ cmd: 'start', salt, difficulty });
      miner.workers.push(w);
    }
    miner.running = true;
    startBtn.textContent = 'Abort search';
    statusValue.textContent = 'SEARCHING_';
    statusValue.classList.add('blink');
    threadCount.textContent = String(miner.threads);
    oRate.set(0);
    tline(
      `hunt started — ${miner.threads} thread${miner.threads > 1 ? 's' : ''} · target ${'0'.repeat(difficulty)} · salt ${short(salt)} — every hash on your cpu`,
      't-prompt'
    );
  }

  function stopMining(reason) {
    if (!miner.running) return;
    miner.workers.forEach((w) => {
      w.postMessage({ cmd: 'stop' });
      w.terminate();
    });
    miner.workers = [];
    miner.running = false;
    miner.hps = 0;
    oRate.set(0);
    startBtn.textContent = 'Start search';
    statusValue.classList.remove('blink');
    if (chainOnline !== false) statusValue.textContent = 'IDLE';
    if (reason !== 'empty') {
      tline(
        `hunt paused — ${fmt(Math.round(miner.hashes))} hashes · ${miner.sessionFinds} treasure${miner.sessionFinds === 1 ? '' : 's'} this session`,
        't-dim'
      );
    }
  }

  function onWorkerMessage(m) {
    if (!m) return;
    if (m.type === 'progress') {
      miner.hashes = m.hashes;
      miner.hps = m.hps;
      miner.lastProbe = m;
    } else if (m.type === 'hit') {
      miner.hashes = m.hashes;
      miner.lastProbe = { nonce: m.nonce, hash: m.hash };
      onHit(m.nonce, m.hash, 0);
    } else if (m.type === 'error') {
      tline('FATAL: ' + m.message, 't-err');
      stopMining();
    }
  }

  async function onHit(nonce, hash, attempt) {
    tline(`HIT ${hash.slice(0, 34)}… nonce ${nonce}`, 't-hit');
    let r;
    try {
      r = await api('/claim', { method: 'POST', body: { nonce, hash } });
    } catch (e) {
      setOnline(false);
      tline('network error — claim lost, continuing', 't-err');
      return;
    }
    if (r.ok) {
      miner.sessionFinds++;
      mFound.textContent = String(miner.sessionFinds);
      updateBalances(r.balanceKxi);
      tline(
        `CLAIM CONFIRMED +${r.creditedKxi.toFixed(3)} KXI → balance ${r.balanceKxi.toFixed(3)} · ${r.remainingKxi.toFixed(1)} left in chain`,
        't-hit'
      );
      pollState(true);
      return;
    }
    if (r.reason === 'taken') {
      tline(`nonce ${nonce} already claimed by another hunter — continuing`, 't-dim');
    } else if (r.reason === 'fast' && attempt < 2) {
      await new Promise((res) => setTimeout(res, 450));
      onHit(nonce, hash, attempt + 1);
    } else if (r.reason === 'empty') {
      tline('CHAIN DRAINED — all coins have been found. the hunt is over.', 't-err');
      stopMining('empty');
    } else if (r.__status === 401) {
      tline('claim rejected — wallet unknown, reloading', 't-err');
      registerWallet();
    } else {
      tline(`claim rejected (${r.reason || r.error || r.__status}) — continuing`, 't-err');
    }
  }

  startBtn.addEventListener('click', () => {
    if (miner.running) stopMining();
    else if (chainOnline) startMining();
  });

  /* probe stream line (throttled) */
  setInterval(() => {
    if (miner.running && miner.lastProbe) {
      const p = miner.lastProbe;
      tline(`${p.nonce} ${p.hash.slice(0, 26)}… ∅`, 't-dim');
    }
  }, 220);

  /* hashrate / counters */
  setInterval(() => {
    if (miner.running) {
      oRate.set(miner.hps / 1000);
      mHashrate.textContent = fmt(miner.hps / 1000, 1) + ' kH/s';
      mTotal.textContent = fmt(Math.round(miner.hashes));
    }
  }, 400);

  /* ---------- state polling & rendering ---------- */
  let seenTxIds = new Set();
  let firstWalletRender = true;
  let lastBlockHeight = -1;
  let lastTxId = null;

  async function pollState(quick) {
    let r;
    try {
      r = await api('/state' + (wallet.address ? '?address=' + wallet.address : ''));
    } catch (e) {
      setOnline(false);
      return;
    }
    if (!r.ok) {
      setOnline(false);
      return;
    }
    setOnline(true);
    state = r;
    renderState();
  }

  function renderState() {
    const c = state.chain;
    const net = state.net;

    /* hero */
    oBlock.set(c.height);
    oRemain.set(c.remainingKxi);
    oFound.set(c.treasuresFound);
    oHunters.set(net.huntersOnline);

    /* chain params panel */
    $('#pTarget').textContent = c.target + ` (${c.difficulty * 4} bits)`;
    $('#pTreasure').textContent = c.treasureKxi.toFixed(3) + ' KXI';
    $('#pSupply').textContent = `${c.minedKxi.toFixed(1)} / ${fmt(c.totalSupplyKxi, 1)} mined`;
    $('#pSalt').textContent = short(c.salt);

    /* wallet balance */
    if (state.wallet) updateBalances(state.wallet.balanceKxi);

    /* incoming tx notifications */
    if (state.wallet && state.wallet.txs) {
      const fresh = state.wallet.txs.filter((t) => !seenTxIds.has(t.id));
      if (!firstWalletRender) {
        for (const t of fresh) {
          if (t.kind === 'transfer' && t.dst === wallet.address) {
            tline(`+${t.amountKxi.toFixed(3)} KXI received from ${short(t.src)}`, 't-hit');
          }
        }
      }
      state.wallet.txs.forEach((t) => seenTxIds.add(t.id));
      firstWalletRender = false;
      renderTxLog();
    }

    /* difficulty / salt change while mining → restart workers */
    if (miner.running && (miner.params.salt !== c.salt || miner.params.difficulty !== c.difficulty)) {
      tline('chain params changed — restarting local search', 't-dim');
      stopMining();
      startMining();
    }

    renderExplorer();
  }

  function updateBalances(balanceKxi) {
    const b = Number(balanceKxi) || 0;
    $('#mBalance').textContent = b.toFixed(3) + ' KXI';
    $('#wBalance').textContent = b.toFixed(3) + ' KXI';
    $('#walletChip').textContent = `${short(wallet.address)} · ${b.toFixed(3)}`;
  }

  /* ---------- explorer ---------- */
  const age = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  };

  function renderExplorer() {
    const blocks = state.blocks || [];
    const txs = state.txs || [];

    const blocksBody = $('#blocksBody');
    if (!blocks.length) {
      blocksBody.innerHTML = '<tr><td class="td-dim" colspan="4">no blocks yet — genesis awaiting first tx</td></tr>';
    } else {
      const newTop = blocks[0].height > lastBlockHeight && lastBlockHeight !== -1;
      blocksBody.innerHTML = blocks
        .map(
          (b) =>
            `<tr><td>${fmt(b.height)}</td><td title="${b.hash}">${short(b.hash)}</td><td>${b.txCount}</td><td class="td-dim" data-ts="${b.ts}">${age(b.ts)}</td></tr>`
        )
        .join('');
      if (newTop) {
        blocksBody.firstElementChild.classList.add('flash');
        tline(`BLOCK ${fmt(blocks[0].height)} SEALED — ${blocks[0].txCount} txs`, 't-block');
      }
      lastBlockHeight = blocks[0].height;
    }

    const txsBody = $('#txsBody');
    if (!txs.length) {
      txsBody.innerHTML = '<tr><td class="td-dim" colspan="6">no transactions yet — be the first</td></tr>';
    } else {
      const fresh = txs[0].id !== lastTxId && lastTxId !== null;
      txsBody.innerHTML = txs
        .map((t) => {
          const dir = t.kind === 'claim' ? 'COINBASE → ' + short(t.dst) : short(t.src) + ' → ' + short(t.dst);
          const status = t.block === null
            ? '<span class="tx-status">pending</span>'
            : `<span class="tx-status sealed">#${t.block}</span>`;
          return `<tr><td title="${t.id}">${t.id.slice(0, 8)}…</td><td>${t.kind}</td><td>${dir}</td><td>${t.amountKxi.toFixed(3)}</td><td class="td-dim" data-ts="${t.ts}">${age(t.ts)}</td><td>${status}</td></tr>`;
        })
        .join('');
      if (fresh) txsBody.firstElementChild.classList.add('flash');
      lastTxId = txs[0].id;
    }
  }

  setInterval(() => {
    $$('[data-ts]').forEach((el) => {
      el.textContent = age(+el.dataset.ts);
    });
  }, 1000);

  /* ---------- tx log (own wallet) ---------- */
  function renderTxLog() {
    const log = $('#txLog');
    if (!state || !state.wallet || !state.wallet.txs || !state.wallet.txs.length) return;
    log.innerHTML = state.wallet.txs
      .slice(0, 6)
      .map((t) => {
        const status = t.block === null ? 'pending' : '#' + t.block;
        if (t.kind === 'claim')
          return `<div class="t-line t-hit">+ ${t.amountKxi.toFixed(3)} KXI mined · ${status}</div>`;
        if (t.dst === wallet.address)
          return `<div class="t-line">← in ${t.amountKxi.toFixed(3)} KXI from ${short(t.src)} · ${status}</div>`;
        return `<div class="t-line t-dim">→ out ${t.amountKxi.toFixed(3)} KXI to ${short(t.dst)} · ${status}</div>`;
      })
      .join('');
  }

  /* ---------- transfers ---------- */
  const toInput = $('#toInput');
  const amtInput = $('#amtInput');
  const memoInput = $('#memoInput');
  const transferError = $('#transferError');

  function transferErr(msg) {
    transferError.textContent = 'ERR_ ' + msg;
    transferError.classList.add('show');
  }
  function transferErrClear() {
    transferError.classList.remove('show');
  }

  toInput.addEventListener('input', transferErrClear);
  amtInput.addEventListener('input', transferErrClear);

  async function sendTransfer() {
    transferErrClear();
    const to = toInput.value.trim().toLowerCase();
    const amount = Number(amtInput.value.replace(',', '.').trim());
    if (!ADDR_RE.test(to)) return transferErr('recipient must be 0x + 40 hex chars');
    if (!isFinite(amount) || amount <= 0) return transferErr('enter an amount in KXI (e.g. 0.5)');
    const amountMilli = Math.round(amount * 1000);
    if (amountMilli <= 0) return transferErr('minimum transfer is 0.001 KXI');
    const bal = state && state.wallet ? state.wallet.balanceKxi : 0;
    if (amountMilli > Math.round(bal * 1000))
      return transferErr(`insufficient balance — you have ${bal.toFixed(3)} KXI`);

    sendBtn.disabled = true;
    let r;
    try {
      r = await api('/transfer', { method: 'POST', body: { to, amount, memo: memoInput.value.trim() } });
    } catch (e) {
      sendBtn.disabled = false;
      setOnline(false);
      return transferErr('network error — try again');
    }
    sendBtn.disabled = false;

    if (r.ok) {
      tline(`TX ${short(r.txId)} → ${short(to)} · ${r.amountKxi.toFixed(3)} KXI sent`, 't-hit');
      amtInput.value = '';
      memoInput.value = '';
      updateBalances(r.balanceKxi);
      pollState(true);
    } else if (r.reason === 'nokey') {
      transferErr('recipient has no wallet yet — they must open the site first');
      tline('transfer rejected — recipient unknown', 't-err');
    } else if (r.reason === 'funds') {
      transferErr(r.error || 'insufficient balance');
    } else if (r.__status === 401) {
      transferErr('wallet not registered — reload the page');
      registerWallet();
    } else {
      transferErr(r.error || 'transfer failed');
    }
  }

  sendBtn.addEventListener('click', sendTransfer);
  amtInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendTransfer();
  });

  /* ---------- wallet card ---------- */
  const wSecret = $('#wSecret');
  const importSecret = $('#importSecret');
  let keyRevealed = false;

  $('#wAddress').textContent = wallet.address || '…';

  $('#wShowKey').addEventListener('click', () => {
    keyRevealed = !keyRevealed;
    if (keyRevealed) {
      wSecret.textContent = wallet.secret;
      wSecret.classList.add('revealed');
      $('#wShowKey').textContent = 'Hide key';
    } else {
      wSecret.textContent = '·'.repeat(64);
      wSecret.classList.remove('revealed');
      $('#wShowKey').textContent = 'Show key';
    }
  });

  function copyText(text, btn, okLabel) {
    const done = () => {
      const old = btn.textContent;
      btn.textContent = okLabel || 'Copied';
      setTimeout(() => {
        btn.textContent = old;
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  $('#wCopyKey').addEventListener('click', (e) => copyText(wallet.secret, e.currentTarget, 'Key copied'));
  $('#wCopyAddr').addEventListener('click', (e) => copyText(wallet.address, e.currentTarget, 'Address copied'));

  $('#importBtn').addEventListener('click', async () => {
    const secret = importSecret.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(secret)) {
      importSecret.classList.add('input-err');
      tline('import rejected — key must be 64 hex chars', 't-err');
      return;
    }
    importSecret.classList.remove('input-err');
    const d = await derive(secret);
    wallet.secret = secret;
    wallet.address = d.address;
    wallet.authKey = d.authKey;
    saveWallet();
    seenTxIds = new Set();
    firstWalletRender = true;
    const r = await registerWallet();
    if (r && r.ok) {
      $('#wAddress').textContent = wallet.address;
      tline(`wallet restored — ${short(wallet.address)} — sync balances from chain`, 't-prompt');
      pollState(true);
    } else {
      tline('import failed — backend unreachable', 't-err');
    }
  });

  $('#newWalletBtn').addEventListener('click', async () => {
    if (!window.confirm('Generate a NEW wallet? The current one stays on-chain, but you lose access unless you saved its key.')) return;
    if (!window.confirm('Really start fresh? Save the old key first if unsure.')) return;
    localStorage.removeItem(LS_KEY);
    wallet.secret = randomSecret();
    const d = await derive(wallet.secret);
    wallet.address = d.address;
    wallet.authKey = d.authKey;
    saveWallet();
    seenTxIds = new Set();
    firstWalletRender = true;
    await registerWallet();
    $('#wAddress').textContent = wallet.address;
    tline(`new wallet minted — ${short(wallet.address)} — balance 0`, 't-prompt');
    pollState(true);
  });

  $('#walletChip').addEventListener('click', () => {
    $('#transfer').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
  });

  /* ---------- ambient chatter (real chain data) ---------- */
  (function ambient() {
    setTimeout(() => {
      if (state && state.ok) {
        const c = state.chain;
        const r = Math.random();
        if (r < 0.4)
          tline(`sync — height ${fmt(c.height)} · ${state.net.pendingTxs} tx pending · salt ${short(c.salt)}`, 't-dim');
        else if (r < 0.75)
          tline(`chain ${c.minedKxi.toFixed(1)} / ${fmt(c.totalSupplyKxi, 1)} KXI mined · ${fmt(c.treasuresTotal - c.treasuresFound)} treasures still hidden`, 't-dim');
        else
          tline(`hunters online ${fmt(state.net.huntersOnline)} · wallets ${fmt(state.net.walletsTotal)} · txs ${fmt(state.net.txsTotal)}`, 't-dim');
      }
      ambient();
    }, randInt(9000, 16000));
  })();

  /* ---------- init ---------- */
  async function init() {
    $('#year').textContent = String(new Date().getFullYear());
    if (!crypto || !crypto.subtle) {
      setOnline(false);
      tline('FATAL: WebCrypto unavailable — wallet cannot be minted', 't-err');
      return;
    }
    await initWallet();
    $('#wAddress').textContent = wallet.address;
    wSecret.textContent = '·'.repeat(64);
    if (wallet.isNew)
      tline(`wallet minted — ${short(wallet.address)} — key saved to this browser only`, 't-hit');
    else
      tline(`wallet restored from browser — ${short(wallet.address)}`, 't-dim');

    const reg = await registerWallet();
    if (reg && reg.ok) {
      tline(
        `chain connected — height ${reg.wallet ? '' : ''}sync ok — registering heartbeat`,
        't-dim'
      );
    } else {
      tline('CHAIN OFFLINE — deploy the free backend (see DEPLOY.md in the repo)', 't-err');
      tline('site works read-only: explorer frozen, mining and transfers disabled', 't-dim');
    }

    await pollState(true);
    if (state && state.ok) {
      const c = state.chain;
      tline(
        `chain online — height ${fmt(c.height)} · target ${c.target} · treasure ${c.treasureKxi.toFixed(3)} KXI · supply ${fmt(c.totalSupplyKxi, 1)} KXI`,
        't-prompt'
      );
    }

    setInterval(() => pollState(true), 12000);
    setInterval(() => {
      if (chainOnline) registerWallet();
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && chainOnline) pollState(true);
    });
  }

  init();
})();
