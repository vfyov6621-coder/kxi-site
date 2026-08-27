/* ═══════════════════════════════════════════════════════════
   kxi — find the token in the chaos
   hash streaming · odometers · hunt simulator · buy calc · explorer feed
   ═══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ---------- utils ---------- */
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const rand = (a, b) => Math.random() * (b - a) + a;
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const HEXC = '0123456789abcdef';
  const hex = (n) => {
    let s = '';
    while (s.length < n) s += HEXC[randInt(0, 15)];
    return s;
  };
  const addr = () => '0x' + hex(40);
  const fmt = (n, d = 0) =>
    Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const short = (h) => h.slice(0, 10) + '…' + h.slice(-6);
  const pad = (n, l) => String(n).padStart(l, '0');
  const validAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v).trim());
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
        if (Math.abs(d) < 0.6) this.cur = this.val;
        else this.cur += d * 0.12;
        this.el.textContent = this.f(this.cur);
        if (Math.abs(this.val - this.cur) >= 0.6) this.tick();
        else {
          this.cur = this.val;
          this.el.textContent = this.f(this.val);
          this.raf = null;
        }
      });
    }
  }

  /* ---------- terminal ---------- */
  const termBody = $('#terminalBody');
  const TERM_MAX = 80;
  const tline = (text, cls) => {
    const el = document.createElement('div');
    el.className = 't-line' + (cls ? ' ' + cls : '');
    el.textContent = text;
    termBody.appendChild(el);
    while (termBody.children.length > TERM_MAX) termBody.removeChild(termBody.firstChild);
    termBody.scrollTop = termBody.scrollHeight;
  };

  /* ---------- hero stats ---------- */
  let height = 2481062;
  let net = 184.2;
  let today = 13370;
  let hunters = 8204;
  let space = 4.2e-11;

  const oBlock = new Odo($('#statBlock'), height);
  const oNet = new Odo($('#statNet'), net, (v) => fmt(v, 1) + ' PH/s');
  const oToday = new Odo($('#statToday'), today);
  const oHunters = new Odo($('#statHunters'), hunters);
  const oSpace = new Odo($('#statSpace'), space, (v) => v.toFixed(12) + '%');

  setInterval(() => {
    net = Math.min(212, Math.max(152, net + rand(-6, 6)));
    oNet.set(net);
  }, 2600);

  /* ---------- ambient network chatter ---------- */
  (function ambient() {
    setTimeout(() => {
      const r = Math.random();
      if (r < 0.5) {
        const amt = rand(0.4, 14.5);
        today += amt;
        tline(`hunter 0x${hex(4)}…${hex(4)} hit ${amt.toFixed(2)} KXI at 0x00000${hex(6)}…`, 't-dim');
      } else if (r < 0.75) {
        tline(`mempool ${fmt(randInt(3000, 9000))} txs · median fee ${rand(0.001, 0.02).toFixed(4)} KXI`, 't-dim');
      } else if (r < 0.9) {
        hunters = Math.max(7600, hunters + randInt(-40, 55));
        tline(`hunters online ${fmt(hunters)} · net ${fmt(rand(160, 210), 1)} PH/s`, 't-dim');
      } else {
        tline(`retarget in ${randInt(40, 512)} blocks · difficulty holds 1/1,048,576`, 't-dim');
      }
      space += rand(0.5, 2) * 1e-13;
      oToday.set(today);
      oHunters.set(hunters);
      oSpace.set(space);
      ambient();
    }, randInt(7000, 14000));
  })();

  /* ---------- idle probes (stream before hunt starts) ---------- */
  (function idleProbes() {
    setTimeout(() => {
      if (!running) tline(`${pad(randInt(100000, 9999999), 7)} 0x${hex(24)}… ∅`, 't-dim');
      idleProbes();
    }, randInt(900, 1700));
  })();

  /* ---------- mining ---------- */
  const walletInput = $('#walletInput');
  const walletError = $('#walletError');
  const startBtn = $('#startBtn');
  const statusValue = $('#statusValue');
  const oHash = new Odo($('#mHashrate'), 0, (v) => fmt(v, 1) + ' kH/s');
  const oTotal = new Odo($('#mTotal'), 0);
  const oFound = new Odo($('#mFound'), 0, (v) => fmt(v, 2));

  let running = false;
  let nonce = randInt(100000, 999999);
  let hps = rand(45, 65);
  let totalHashes = 0;
  let found = 0;
  let startTs = 0;
  let probeTimer = null;
  let statTimer = null;
  let upTimer = null;

  function startHunt() {
    running = true;
    startBtn.textContent = 'Abort search';
    statusValue.textContent = 'SEARCHING_';
    statusValue.classList.add('blink');
    startTs = Date.now();
    tline(`hunt started — wallet ${short(walletInput.value.trim())} — target prefix 0x00000…`);
    probe();
    statTimer = setInterval(() => {
      hps = Math.min(74, Math.max(38, hps + rand(-5, 5)));
      totalHashes += hps * 1000 * 0.6;
      oHash.set(hps);
      oTotal.set(totalHashes);
    }, 600);
    upTimer = setInterval(() => {
      const s = Math.floor((Date.now() - startTs) / 1000);
      $('#mUptime').textContent = pad(Math.floor(s / 60), 2) + ':' + pad(s % 60, 2);
    }, 1000);
  }

  function stopHunt() {
    running = false;
    clearTimeout(probeTimer);
    clearInterval(statTimer);
    clearInterval(upTimer);
    startBtn.textContent = 'Start search';
    statusValue.textContent = 'IDLE';
    statusValue.classList.remove('blink');
    tline(`hunt aborted — ${found.toFixed(2)} KXI found — ${fmt(totalHashes)} probes logged`, 't-dim');
  }

  function probe() {
    if (!running) return;
    nonce += 1;
    const roll = Math.random();
    if (roll < 0.0035) {
      const reward = rand(0.4, 12.5);
      const h = '0x00000' + hex(59);
      found += reward;
      today += reward;
      oFound.set(found);
      oToday.set(today);
      tline(`HIT ${short(h)} +${reward.toFixed(2)} KXI → ${short(walletInput.value.trim())}`, 't-hit');
    } else if (roll < 0.05) {
      const h = '0x00' + hex(62);
      tline(`${pad(nonce, 7)} ${short(h)} ∅ near-miss`, 't-near');
    } else {
      const h = '0x' + hex(64);
      tline(`${pad(nonce, 7)} ${short(h)} ∅`);
    }
    probeTimer = setTimeout(probe, randInt(80, 150));
  }

  startBtn.addEventListener('click', () => {
    if (running) {
      stopHunt();
      return;
    }
    if (!validAddr(walletInput.value)) {
      walletError.classList.add('show');
      walletInput.classList.add('input-err');
      tline('ERR: wallet rejected — expected 0x + 40 hex chars', 't-err');
      return;
    }
    walletError.classList.remove('show');
    walletInput.classList.remove('input-err');
    startHunt();
  });

  walletInput.addEventListener('input', () => {
    walletError.classList.remove('show');
    walletInput.classList.remove('input-err');
  });
  walletInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startBtn.click();
  });

  /* ---------- rates & buy ---------- */
  const FEE = 0.01;
  const CURS = ['RUB', 'USD', 'BTC'];
  const rates = {
    RUB: { rate: 4.872, chg: 2.41, vol: 18402551 },
    USD: { rate: 0.05214, chg: -1.08, vol: 196447 },
    BTC: { rate: 0.00000061, chg: 0.63, vol: 2.41 },
  };
  let currency = 'RUB';
  let orderN = randInt(400, 900);
  const buyAmount = $('#buyAmount');

  const fmtRate = (v, c) => (c === 'RUB' ? v.toFixed(4) : c === 'USD' ? v.toFixed(5) : v.toFixed(8));

  function renderRates(flashCells) {
    CURS.forEach((c) => {
      const r = rates[c];
      const rateEl = $('#rate-' + c);
      rateEl.textContent = fmtRate(r.rate, c);
      $('#chg-' + c).textContent = (r.chg >= 0 ? '+' : '-') + Math.abs(r.chg).toFixed(2) + '%';
      $('#vol-' + c).textContent = c === 'BTC' ? fmt(r.vol, 2) : fmt(Math.round(r.vol));
      if (flashCells) {
        rateEl.classList.remove('flash');
        void rateEl.offsetWidth;
        rateEl.classList.add('flash');
      }
    });
  }

  function calc() {
    const raw = buyAmount.value.replace(',', '.').trim();
    const amt = parseFloat(raw);
    const r = rates[currency];
    $('#calcRate').textContent = '1 KXI = ' + fmtRate(r.rate, currency) + ' ' + currency;
    if (!isFinite(amt) || amt <= 0) {
      $('#calcFee').textContent = '—';
      $('#calcReceive').textContent = '0 KXI';
      return { amt: 0, recv: 0 };
    }
    const fee = amt * FEE;
    const recv = (amt - fee) / r.rate;
    $('#calcFee').textContent = (fee < 1 ? fmt(fee, 6) : fmt(fee, 2)) + ' ' + currency;
    $('#calcReceive').textContent = fmt(recv, 2) + ' KXI';
    return { amt, recv };
  }

  const orderLog = $('#orderLog');
  function olog(text, cls) {
    const el = document.createElement('div');
    el.className = 't-line' + (cls ? ' ' + cls : '');
    el.textContent = '> ' + text;
    orderLog.prepend(el);
    while (orderLog.children.length > 4) orderLog.removeChild(orderLog.lastChild);
  }

  $$('.pair-btn').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.pair-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      currency = b.dataset.currency;
      $('#payLabel').textContent = 'You pay — ' + currency;
      calc();
    });
  });

  buyAmount.addEventListener('input', calc);
  buyAmount.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#buyBtn').click();
  });

  $('#buyBtn').addEventListener('click', () => {
    const c = calc();
    if (!c.amt) {
      olog('ERR: enter an amount first', 't-err');
      return;
    }
    orderN += 1;
    const w = validAddr(walletInput.value) ? short(walletInput.value.trim()) : 'escrow ' + short(addr());
    olog(`ORDER #${pad(orderN, 6)} FILLED — ${fmt(c.recv, 2)} KXI → ${w} — FINAL`, 't-hit');
    rates[currency].vol += c.amt;
    renderRates(false);
  });

  setInterval(() => {
    CURS.forEach((c) => {
      const r = rates[c];
      r.rate *= 1 + rand(-0.004, 0.004);
      r.chg = Math.max(-9.99, Math.min(9.99, r.chg + rand(-0.07, 0.07)));
    });
    renderRates(true);
    calc();
  }, 4000);

  renderRates(false);
  calc();

  /* ---------- explorer ---------- */
  const blocksBody = $('#blocksBody');
  const txsBody = $('#txsBody');
  const blocks = [];
  const txs = [];

  const makeBlock = (h, ts) => ({ h, hash: '0x' + hex(64), txs: randInt(1, 24), miner: addr(), ts });
  const makeTx = (ts) => ({ hash: '0x' + hex(64), from: addr(), to: addr(), amt: rand(0.01, 940), ts });

  const age = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  };

  const blocksHTML = () =>
    blocks
      .map(
        (b) =>
          `<tr><td>${fmt(b.h)}</td><td title="${b.hash}">${short(b.hash)}</td><td>${b.txs}</td><td title="${b.miner}">${short(b.miner)}</td><td class="td-dim" data-ts="${b.ts}">${age(b.ts)}</td></tr>`
      )
      .join('');
  const txsHTML = () =>
    txs
      .map(
        (t) =>
          `<tr><td title="${t.hash}">${short(t.hash)}</td><td title="${t.from}">${short(t.from)}</td><td title="${t.to}">${short(t.to)}</td><td>${t.amt.toFixed(2)} KXI</td><td class="td-dim" data-ts="${t.ts}">${age(t.ts)}</td></tr>`
      )
      .join('');

  const flashFirst = (tbody) => {
    if (tbody.firstElementChild) tbody.firstElementChild.classList.add('flash');
  };

  const seedTs = Date.now();
  for (let i = 0; i < 9; i++) blocks.push(makeBlock(height - i, seedTs - i * randInt(9000, 20000)));
  for (let i = 0; i < 9; i++) txs.push(makeTx(seedTs - i * randInt(3000, 9000)));
  blocksBody.innerHTML = blocksHTML();
  txsBody.innerHTML = txsHTML();

  (function blockLoop() {
    setTimeout(() => {
      height += 1;
      const b = makeBlock(height, Date.now());
      blocks.unshift(b);
      if (blocks.length > 9) blocks.pop();
      blocksBody.innerHTML = blocksHTML();
      flashFirst(blocksBody);
      oBlock.set(height);
      tline(`BLOCK ${fmt(height)} SEALED — ${b.txs} txs — 12.5 KXI → ${short(b.miner)}`, 't-block');
      blockLoop();
    }, randInt(9000, 18000));
  })();

  (function txLoop() {
    setTimeout(() => {
      const t = makeTx(Date.now());
      txs.unshift(t);
      if (txs.length > 9) txs.pop();
      txsBody.innerHTML = txsHTML();
      flashFirst(txsBody);
      txLoop();
    }, randInt(2400, 6000));
  })();

  setInterval(() => {
    $$('[data-ts]').forEach((el) => {
      el.textContent = age(+el.dataset.ts);
    });
  }, 1000);

  /* ---------- wallet connect ---------- */
  const connectBtn = $('#connectBtn');
  let wallet = null;
  connectBtn.addEventListener('click', () => {
    if (wallet) {
      wallet = null;
      connectBtn.textContent = 'Connect Wallet';
      connectBtn.classList.remove('connected');
      connectBtn.removeAttribute('title');
      tline('wallet unlinked — payouts suspended', 't-dim');
    } else {
      wallet = addr();
      connectBtn.textContent = short(wallet);
      connectBtn.classList.add('connected');
      connectBtn.title = wallet;
      walletInput.value = wallet;
      walletError.classList.remove('show');
      walletInput.classList.remove('input-err');
      tline(`wallet linked — payouts route to ${short(wallet)}`, 't-dim');
    }
  });

  /* ---------- misc ---------- */
  $('#year').textContent = String(new Date().getFullYear());

  setTimeout(() => {
    tline(`node synced — height ${fmt(height)} — 9 peers — tip ${short(blocks[0].hash)}`, 't-dim');
  }, 900);
})();
