#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kxi-miner — console miner for the kxi proof-of-search chain.

One file. CPU mode needs nothing but python itself.
GPU mode (OpenCL — like bitcoin in the old days):
    pip install pyopencl numpy

quick start:
    python kxi-miner.py                     # cpu mining, wallet auto-created
    python kxi-miner.py --gpu               # gpu mining
    python kxi-miner.py --key <64-hex>      # mine into your browser wallet
    python kxi-miner.py --info              # show chain state
    python kxi-miner.py --send 0.5 --to 0x… # on-chain transfer
    python kxi-miner.py --benchmark         # measure local hashrate

The wallet secret is stored in kxi-wallet.json next to this file.
Import that key on the site (Wallet section -> Import key) to use
your coins in a browser. Every proof is re-verified by the chain:
the server never mines, it only checks.
"""

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import queue as queue_mod
import random
import secrets
import sys
import time
import urllib.error
import urllib.request

VERSION = "1.0.0"
DEFAULT_API = "https://kxi-chain.pages.dev"
WALLET_FILE = "kxi-wallet.json"
MASK48 = (1 << 48) - 1
NONCE_LEN = 12

# ═══════════════════════════════════════════════════════════════
#  OpenCL kernel — sha256("salt:nonce") leading-zero search.
#  The core (kxi_hash / kxi_try) is plain C and is also compiled
#  with gcc by the test harness to verify against hashlib.
# ═══════════════════════════════════════════════════════════════
KERNEL_SRC = r'''
#define KXI_UNROLL 256
#define KXI_MAX_WIN 64

__constant uint KC[64] = {
  0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
  0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
  0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
  0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
  0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
  0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
  0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
  0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};

uint rotr(uint x, uint n) { return (x >> n) | (x << (32u - n)); }
uint Ch(uint x, uint y, uint z)  { return z ^ (x & (y ^ z)); }
uint Maj(uint x, uint y, uint z) { return (x & y) | (z & (x | y)); }
uint Sig0(uint x) { return rotr(x, 2u) ^ rotr(x, 13u) ^ rotr(x, 22u); }
uint Sig1(uint x) { return rotr(x, 6u) ^ rotr(x, 11u) ^ rotr(x, 25u); }
uint sg0(uint x)  { return rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3); }
uint sg1(uint x)  { return rotr(x, 17u) ^ rotr(x, 19u) ^ (x >> 10); }

void sha256_compress(uint *s, const uint *w) {
  uint W[64];
  for (int i = 0; i < 16; i++) W[i] = w[i];
  for (int i = 16; i < 64; i++)
    W[i] = sg1(W[i-2]) + W[i-7] + sg0(W[i-15]) + W[i-16];
  uint a=s[0], b=s[1], c=s[2], d=s[3], e=s[4], f=s[5], g=s[6], h=s[7];
  #pragma unroll
  for (int i = 0; i < 64; i++) {
    uint t1 = h + Sig1(e) + Ch(e, f, g) + KC[i] + W[i];
    uint t2 = Sig0(a) + Maj(a, b, c);
    h = g; g = f; f = e; e = d + t1;
    d = c; c = b; b = a; a = t1 + t2;
  }
  s[0]+=a; s[1]+=b; s[2]+=c; s[3]+=d; s[4]+=e; s[5]+=f; s[6]+=g; s[7]+=h;
}

/* sha256("salt:" + 12-hex-nonce(counter)) -> out[8]; salt_len <= 106 */
void kxi_hash(const uchar *salt, uint salt_len, ulong counter, uint *out) {
  uchar buf[128];
  uint len = salt_len + 13;               /* salt + ':' + 12 nonce chars */
  uint i;
  for (i = 0; i < salt_len; i++) buf[i] = salt[i];
  buf[salt_len] = (uchar)':';
  ulong c = counter;
  for (int j = 11; j >= 0; j--) { buf[salt_len + 1 + j] = (uchar)"0123456789abcdef"[c & 0xF]; c >>= 4; }
  buf[len] = (uchar)0x80;
  uint total = (len + 9u + 63u) & ~63u;   /* padded length: 64 or 128    */
  for (i = len + 1; i < total; i++) buf[i] = 0;
  buf[total - 1] = (uchar)(len << 3);     /* bit length, low bytes       */
  buf[total - 2] = (uchar)(len >> 5);

  uint s[8] = { 0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
                0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u };
  uint w[16];
  for (uint blk = 0; blk < total; blk += 64u) {
    for (int k = 0; k < 16; k++)
      w[k] = ((uint)buf[blk + 4*k] << 24) | ((uint)buf[blk + 4*k + 1] << 16)
           | ((uint)buf[blk + 4*k + 2] << 8) | (uint)buf[blk + 4*k + 3];
    sha256_compress(s, w);
  }
  for (int k = 0; k < 8; k++) out[k] = s[k];
}

/* 1 if hash meets difficulty (leading zero hex chars); nonce copied to out */
int kxi_try(const uchar *salt, uint salt_len, uint difficulty, ulong counter, uchar *nonce_out) {
  if (salt_len > 106) return 0;
  if (difficulty == 0) { return 1; }
  uint h[8];
  kxi_hash(salt, salt_len, counter, h);
  uint shift = 32u - 4u * difficulty;     /* difficulty 1..8              */
  if (h[0] < (1u << shift)) {
    ulong c = counter;
    for (int j = 11; j >= 0; j--) { nonce_out[j] = (uchar)"0123456789abcdef"[c & 0xF]; c >>= 4; }
    return 1;
  }
  return 0;
}

__kernel void kxi_mine(__global const uchar *salt,
                       const uint salt_len,
                       const uint difficulty,
                       const ulong batch_offset,
                       __global uchar *winners,          /* KXI_MAX_WIN * 12 */
                       __global volatile int *win_count) {
  ulong base = batch_offset + (ulong)get_global_id(0) * (ulong)KXI_UNROLL;
  uchar nc[12];
  for (uint i = 0; i < KXI_UNROLL; i++) {
    if (kxi_try(salt, salt_len, difficulty, base + (ulong)i, nc)) {
      int slot = atomic_inc(win_count);
      if (slot < KXI_MAX_WIN)
        for (int j = 0; j < 12; j++) winners[slot * 12 + j] = nc[j];
    }
  }
}
'''

# ═══════════════════════════════════════════════════════════════
#  helpers
# ═══════════════════════════════════════════════════════════════

def sha256_hex(s):
    if isinstance(s, str):
        s = s.encode()
    return hashlib.sha256(s).hexdigest()


def fmt_int(n):
    return "{:,}".format(int(n))


def fmt_rate(hps):
    if hps >= 1e9:
        return "%.2f GH/s" % (hps / 1e9)
    if hps >= 1e6:
        return "%.2f MH/s" % (hps / 1e6)
    if hps >= 1e3:
        return "%.1f kH/s" % (hps / 1e3)
    return "%.0f H/s" % hps


def short(h):
    h = str(h)
    return h[:10] + "..." + h[-6:] if len(h) > 20 else h


class Drained(Exception):
    pass


# ═══════════════════════════════════════════════════════════════
#  API client (stdlib urllib)
# ═══════════════════════════════════════════════════════════════

class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def _call(self, method, path, key=None, body=None, timeout=25):
        req = urllib.request.Request(self.base + path, method=method)
        req.add_header("content-type", "application/json")
        if key:
            req.add_header("x-kxi-key", key)
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urllib.request.urlopen(req, data, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                out = json.loads(e.read().decode())
                out["__status"] = e.code
                return out
            except Exception:
                return {"ok": False, "error": "HTTP %d" % e.code, "__status": e.code}
        except Exception as e:
            return {"ok": False, "error": "network: %s" % e, "network": True}

    def state(self, address=None):
        q = "?address=" + address if address else ""
        return self._call("GET", "/api/state" + q)

    def register(self, key):
        return self._call("POST", "/api/wallet", key=key, body={})

    def claim(self, key, nonce, hashhex):
        return self._call("POST", "/api/claim", key=key, body={"nonce": nonce, "hash": hashhex})

    def transfer(self, key, to, amount, memo=""):
        return self._call("POST", "/api/transfer", key=key,
                          body={"to": to, "amount": amount, "memo": memo})


# ═══════════════════════════════════════════════════════════════
#  wallet (same derivation as the browser: secret -> authKey -> address)
# ═══════════════════════════════════════════════════════════════

def derive(secret):
    auth_key = sha256_hex("kxi/auth:" + secret)
    address = "0x" + sha256_hex("kxi/addr:" + auth_key)[:40]
    return auth_key, address


def load_or_create_wallet(path, force_new=False):
    if not force_new and os.path.exists(path):
        try:
            with open(path, "r") as f:
                w = json.load(f)
            if isinstance(w.get("secret"), str) and len(w["secret"]) == 64:
                try:
                    int(w["secret"], 16)
                    return w["secret"], False
                except ValueError:
                    pass
        except Exception:
            pass
    secret = secrets.token_hex(32)
    with open(path, "w") as f:
        json.dump({"secret": secret, "created": time.strftime("%Y-%m-%dT%H:%M:%S")}, f)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return secret, True


# ═══════════════════════════════════════════════════════════════
#  CPU worker — child process, never touches the network
# ═══════════════════════════════════════════════════════════════

def cpu_worker(prefix, difficulty, start, stride, stop_evt, out_q):
    sha = hashlib.sha256
    nfull = difficulty // 2
    need_low = difficulty & 1
    zeros = b"\x00" * nfull
    fmt = b"%012x"
    batch = 4096
    count = 0
    t0 = time.time()
    c = start & MASK48
    try:
        while not stop_evt.is_set():
            for _ in range(batch):
                d = sha(prefix + (fmt % c)).digest()
                if d[:nfull] == zeros and (not need_low or d[nfull] < 16):
                    try:
                        out_q.put_nowait(("hit", (fmt % c).decode("ascii"), d.hex()))
                    except queue_mod.Full:
                        pass  # claim pipe saturated -- nonce will be found by someone else
                c = (c + stride) & MASK48
            count += batch
            if time.time() - t0 >= 1.0:
                try:
                    out_q.put_nowait(("rate", count))
                except queue_mod.Full:
                    pass
                count = 0
                t0 = time.time()
    except KeyboardInterrupt:
        pass
    finally:
        if count:
            out_q.put(("rate", count))


# ═══════════════════════════════════════════════════════════════
#  GPU miner — OpenCL (like bitcoin in the old days)
# ═══════════════════════════════════════════════════════════════

class GpuMiner:
    def __init__(self):
        import numpy as np
        import pyopencl as cl
        self.np = np
        self.cl = cl
        plat_dev = None
        for plat in cl.get_platforms():
            for dev in plat.get_devices():
                if dev.type & cl.device_type.GPU:
                    plat_dev = (plat, dev)
                    break
            if plat_dev:
                break
        if plat_dev is None:
            for plat in cl.get_platforms():
                if plat.get_devices():
                    plat_dev = (plat, plat.get_devices()[0])
                    break
        if plat_dev is None:
            raise RuntimeError("no OpenCL device found")
        self.platform, self.device = plat_dev
        self.ctx = cl.Context([self.device])
        self.queue = cl.CommandQueue(self.ctx)
        self.prog = cl.Program(self.ctx, KERNEL_SRC).build()
        self.unroll = 256
        self.max_win = 64

    def run_batch(self, salt_bytes, difficulty, offset, log2_total):
        """Run 2^log2_total nonce candidates. Returns (hits, hashes, seconds)."""
        np, cl = self.np, self.cl
        total = 1 << log2_total
        global_size = total // self.unroll
        salt_buf = cl.Buffer(self.ctx, cl.mem_flags.READ_ONLY | cl.mem_flags.COPY_HOST_PTR,
                             hostbuf=np.frombuffer(salt_bytes, dtype=np.uint8))
        winners = np.zeros(self.max_win * 12, dtype=np.uint8)
        wincnt = np.zeros(1, dtype=np.int32)
        win_buf = cl.Buffer(self.ctx, cl.mem_flags.WRITE_ONLY, size=winners.nbytes)
        cnt_buf = cl.Buffer(self.ctx, cl.mem_flags.READ_WRITE | cl.mem_flags.COPY_HOST_PTR,
                            hostbuf=wincnt)
        t0 = time.time()
        self.prog.kxi_mine(
            self.queue, (global_size,), None,
            salt_buf, np.uint32(len(salt_bytes)), np.uint32(difficulty),
            np.uint64(offset), win_buf, cnt_buf)
        try:
            self.queue.finish()
        except Exception:
            pass
        elapsed = time.time() - t0
        cl.enqueue_copy(self.queue, wincnt, cnt_buf)
        n = int(wincnt[0])
        hits = []
        if n > 0:
            cl.enqueue_copy(self.queue, winners, win_buf)
            for i in range(min(n, self.max_win)):
                nonce = bytes(winners[i * 12:(i + 1) * 12]).decode("ascii")
                hits.append(nonce)
        return hits, total, elapsed

    def verify(self, salt, nonce, difficulty):
        """Host-side recheck of a kernel hit (defense in depth)."""
        h = hashlib.sha256(("%s:%s" % (salt, nonce)).encode()).hexdigest()
        return h.startswith("0" * difficulty), h


# ═══════════════════════════════════════════════════════════════
#  console output
# ═══════════════════════════════════════════════════════════════

class Display:
    def __init__(self):
        self._prev_len = 0

    def status(self, line):
        pad = max(0, self._prev_len - len(line))
        sys.stdout.write("\r" + line + " " * pad)
        sys.stdout.flush()
        self._prev_len = len(line)

    def event(self, line):
        sys.stdout.write("\r" + " " * self._prev_len + "\n")
        print(line)
        sys.stdout.flush()
        self._prev_len = 0


def banner(mode_desc):
    print("+--------------------------------------------------------------+")
    print("|  kxi-miner v%s  --  proof-of-search, local brute force      |" % VERSION)
    print("|  cpu + gpu (opencl)  .  first valid proof claims the coin   |")
    print("+--------------------------------------------------------------+")
    print("mode    : %s" % mode_desc)


# ═══════════════════════════════════════════════════════════════
#  claim handling
# ═══════════════════════════════════════════════════════════════

def do_claim(api, key, nonce, hashhex, disp, totals):
    for attempt in range(4):
        r = api.claim(key, nonce, hashhex)
        if r.get("ok"):
            totals["hits"] += 1
            totals["credited"] += r.get("creditedKxi", 0.0)
            totals["balance"] = r.get("balanceKxi", totals["balance"])
            disp.event("HIT    nonce %s  ->  CLAIM CONFIRMED  +%.3f KXI  (balance %.3f, %.1f left)"
                       % (nonce, r.get("creditedKxi", 0), r.get("balanceKxi", 0), r.get("remainingKxi", 0)))
            return
        reason = r.get("reason")
        if reason == "fast":
            time.sleep(0.35)
            continue
        if reason == "taken":
            disp.event("HIT    nonce %s  ->  already claimed by another hunter" % nonce)
            return
        if reason == "empty":
            raise Drained()
        if r.get("__status") == 401 or "unknown wallet" in str(r.get("error", "")):
            rr = api.register(key)
            if not rr.get("ok"):
                disp.event("ERR    wallet rejected: %s" % rr.get("error"))
                return
            continue
        if r.get("network"):
            time.sleep(1.0)
            continue
        disp.event("ERR    claim %s rejected: %s" % (nonce, r.get("error", r.get("reason"))))
        return
    disp.event("ERR    claim %s gave up after retries" % nonce)


def poll_state(api, address, disp, params, totals):
    st = api.state(address)
    if not st.get("ok"):
        if st.get("network"):
            disp.event("WARN   chain unreachable, retrying...")
        return False
    c = st["chain"]
    totals["left"] = c.get("remainingKxi", totals.get("left", 0))
    totals["height"] = c.get("height", 0)
    totals["hunters"] = st.get("net", {}).get("huntersOnline", 0)
    if st.get("wallet"):
        totals["balance"] = st["wallet"].get("balanceKxi", totals.get("balance", 0))
    changed = (params["salt"] != c["salt"] or params["difficulty"] != c["difficulty"])
    params["salt"] = c["salt"]
    params["difficulty"] = c["difficulty"]
    params["treasure"] = c.get("treasureKxi", 0.5)
    if c.get("remainingKxi", 1) < c.get("treasureKxi", 0.5):
        raise Drained()
    return changed


# ═══════════════════════════════════════════════════════════════
#  main loops
# ═══════════════════════════════════════════════════════════════

def cpu_loop(api, key, address, params, args, disp, totals):
    stop = mp.Event()
    out_q = mp.Queue(maxsize=1024)
    procs = []

    def spawn():
        n = totals["threads"]
        base = random.getrandbits(48)
        prefix = (params["salt"] + ":").encode()
        for i in range(n):
            p = mp.Process(target=cpu_worker,
                           args=(prefix, params["difficulty"], (base + i) & MASK48, n, stop, out_q),
                           daemon=True)
            p.start()
            procs.append(p)

    spawn()
    disp.event("hunt started -- %d cpu threads -- target %s -- salt %s"
               % (totals["threads"], "0" * params["difficulty"], short(params["salt"])))
    last_state = last_beat = time.time()
    rate_window = []
    try:
        while True:
            try:
                msg = out_q.get(timeout=0.5)
                if msg[0] == "rate":
                    rate_window.append((time.time(), msg[1]))
                    totals["hashes"] += msg[1]
                elif msg[0] == "hit":
                    do_claim(api, key, msg[1], msg[2], disp, totals)
            except queue_mod.Empty:
                pass
            now = time.time()
            if now - last_state > 15:
                last_state = now
                try:
                    if poll_state(api, address, disp, params, totals):
                        disp.event("chain params changed -- restarting search (target %s)"
                                   % ("0" * params["difficulty"]))
                        stop.set()
                        for p in procs:
                            p.join(2)
                        procs = []
                        stop = mp.Event()
                        spawn()
                except Drained:
                    raise
            if now - last_beat > 30:
                last_beat = now
                api.register(key)
            rate_window = [x for x in rate_window if now - x[0] < 4]
            if rate_window:
                inst = sum(x[1] for x in rate_window) / max(1e-9, rate_window[-1][0] - rate_window[0][0] + 0.25)
                totals["rate"] = inst
            disp.status("[%s x%d] %s | %s hashes | hits %d (+%.3f KXI) | bal %.3f | left %.1f KXI | diff %d"
                        % (args.mode, totals["threads"], fmt_rate(totals["rate"]),
                           fmt_int(totals["hashes"]), totals["hits"], totals["credited"],
                           totals["balance"], totals["left"], params["difficulty"]))
    except (KeyboardInterrupt, Drained) as e:
        stop.set()
        for p in procs:
            p.join(2)
        raise


def gpu_loop(api, key, address, params, args, disp, totals):
    gpu = GpuMiner()
    disp.event("gpu     : %s (%s)" % (gpu.device.name.strip(), gpu.platform.name.strip()))
    offset = random.getrandbits(48)
    log2_total = args.gpu_batch
    salt_bytes = params["salt"].encode()
    disp.event("hunt started -- gpu -- target %s -- salt %s"
               % ("0" * params["difficulty"], short(params["salt"])))
    last_state = last_beat = time.time()
    kernel_errors = 0
    try:
        while True:
            hits, hashes, elapsed = gpu.run_batch(salt_bytes, params["difficulty"], offset, log2_total)
            offset = (offset + hashes) & MASK48
            totals["hashes"] += hashes
            totals["rate"] = hashes / max(1e-9, elapsed)
            for nonce in hits:
                ok, hashhex = gpu.verify(params["salt"], nonce, params["difficulty"])
                if not ok:
                    kernel_errors += 1
                    disp.event("ERR    kernel produced invalid nonce %s (bug report welcome)" % nonce)
                    if kernel_errors > 3:
                        raise RuntimeError("kernel verification failed repeatedly")
                    continue
                do_claim(api, key, nonce, hashhex, disp, totals)
            now = time.time()
            if now - last_state > 15:
                last_state = now
                try:
                    if poll_state(api, address, disp, params, totals):
                        disp.event("chain params changed -- retarget %s (gpu picks up next batch)"
                                   % ("0" * params["difficulty"]))
                        salt_bytes = params["salt"].encode()
                except Drained:
                    raise
            if now - last_beat > 30:
                last_beat = now
                api.register(key)
            disp.status("[gpu %s] %s | %s hashes | hits %d (+%.3f KXI) | bal %.3f | left %.1f KXI | diff %d"
                        % (gpu.device.name.strip()[:16], fmt_rate(totals["rate"]),
                           fmt_int(totals["hashes"]), totals["hits"], totals["credited"],
                           totals["balance"], totals["left"], params["difficulty"]))
    except (KeyboardInterrupt, Drained):
        raise


# ═══════════════════════════════════════════════════════════════
#  one-shot commands
# ═══════════════════════════════════════════════════════════════

def cmd_info(api, key, address):
    r = api.register(key)
    st = api.state(address)
    if not st.get("ok"):
        print("chain offline: %s" % st.get("error"))
        return 1
    c, net = st["chain"], st["net"]
    print("chain   : kxi  (block %d)" % c["height"])
    print("supply  : %.1f KXI in %d treasures of %.3f"
          % (c["totalSupplyKxi"], c["treasuresTotal"], c["treasureKxi"]))
    print("mined   : %.1f KXI (%d treasures found, %.1f left)"
          % (c["minedKxi"], c["treasuresFound"], c["remainingKxi"]))
    print("diff    : %d  (target %s)" % (c["difficulty"], c["target"]))
    print("salt    : %s" % c["salt"])
    print("net     : %d hunters online / %d wallets / %d txs"
          % (net["huntersOnline"], net["walletsTotal"], net["txsTotal"]))
    print("wallet  : %s  balance %.3f KXI" % (address, st["wallet"]["balanceKxi"] if st.get("wallet") else 0))
    return 0


def cmd_send(api, key, address, amount, to, memo):
    to = to.strip().lower()
    if not (to.startswith("0x") and len(to) == 42):
        print("bad recipient address (expected 0x + 40 hex)")
        return 1
    r = api.register(key)
    if not r.get("ok"):
        print("chain offline / wallet rejected: %s" % r.get("error"))
        return 1
    st = api.state(address)
    bal = st.get("wallet", {}).get("balanceKxi", 0) if st.get("ok") else 0
    print("sending %.3f KXI -> %s  (balance %.3f)" % (amount, to, bal))
    r = api.transfer(key, to, amount, memo)
    if r.get("ok"):
        print("OK      tx %s  ->  new balance %.3f KXI" % (short(r["txId"]), r["balanceKxi"]))
        return 0
    print("FAILED  %s" % r.get("error", r.get("reason")))
    return 1


def cmd_benchmark(args):
    salt = secrets.token_hex(16)
    difficulty = 8
    seconds = args.bench_time
    if args.gpu:
        try:
            gpu = GpuMiner()
        except ModuleNotFoundError as e:
            print("gpu mode unavailable (%s)" % e)
            print("install it and retry:  pip install pyopencl numpy")
            print("benchmarking cpu instead...\n")
            args.gpu = False
        else:
            print("gpu     : %s (%s)" % (gpu.device.name.strip(), gpu.platform.name.strip()))
            offset = random.getrandbits(48)
            total = 0
            t_end = time.time() + seconds
            while time.time() < t_end:
                _, hashes, elapsed = gpu.run_batch(salt.encode(), difficulty, offset, args.gpu_batch)
                offset = (offset + hashes) & MASK48
                total += hashes
                sys.stdout.write("\r  %s" % fmt_rate(total / max(1e-9, seconds - (t_end - time.time()))))
                sys.stdout.flush()
            print()
    if not args.gpu:
        n = args.threads or max(1, (os.cpu_count() or 2) - 1)
        stop = mp.Event()
        out_q = mp.Queue()
        base = random.getrandbits(48)
        procs = []
        for i in range(n):
            p = mp.Process(target=cpu_worker, args=((salt + ":").encode(), difficulty,
                                                     (base + i) & MASK48, n, stop, out_q), daemon=True)
            p.start()
            procs.append(p)
        total = 0
        t_end = time.time() + seconds
        while time.time() < t_end:
            try:
                msg = out_q.get(timeout=0.4)
                if msg[0] == "rate":
                    total += msg[1]
            except queue_mod.Empty:
                pass
        stop.set()
        for p in procs:
            p.join(2)
        print("cpu     : %d threads" % n)
    print("hashrate: %s  (difficulty %d, sha256)" % (fmt_rate(total / seconds), difficulty))
    return 0


# ═══════════════════════════════════════════════════════════════
#  main
# ═══════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(prog="kxi-miner",
                                 description="kxi proof-of-search console miner (cpu + gpu)")
    ap.add_argument("--api", default=DEFAULT_API, help="backend base url (default %s)" % DEFAULT_API)
    ap.add_argument("--key", help="use this 64-hex wallet secret instead of the wallet file")
    ap.add_argument("--wallet", default=WALLET_FILE, help="wallet file path (default %s)" % WALLET_FILE)
    ap.add_argument("--new-wallet", action="store_true", help="force-create a fresh wallet")
    ap.add_argument("--gpu", action="store_true", help="mine on gpu via OpenCL")
    ap.add_argument("--threads", type=int, default=0, help="cpu threads (default: cores - 1)")
    ap.add_argument("--gpu-batch", type=int, default=25, help="log2 of nonces per gpu launch (default 25)")
    ap.add_argument("--info", action="store_true", help="show chain state and exit")
    ap.add_argument("--send", type=float, metavar="KXI", help="transfer KXI (needs --to)")
    ap.add_argument("--to", help="recipient address for --send")
    ap.add_argument("--memo", default="", help="memo for --send")
    ap.add_argument("--benchmark", action="store_true", help="measure local hashrate and exit")
    ap.add_argument("--bench-time", type=float, default=8.0, help="benchmark seconds (default 8)")
    ap.add_argument("--version", action="store_true", help="print version")
    args = ap.parse_args()

    if args.version:
        print("kxi-miner %s" % VERSION)
        return 0

    if args.benchmark:
        return cmd_benchmark(args)

    # wallet
    if args.key:
        secret = args.key.strip().lower()
        if len(secret) != 64:
            print("--key must be 64 hex chars (copy the secret from the site wallet section)")
            return 1
        try:
            int(secret, 16)
        except ValueError:
            print("--key must be hexadecimal")
            return 1
    else:
        secret, is_new = load_or_create_wallet(args.wallet, args.new_wallet)
    key, address = derive(secret)

    api = Api(args.api)

    if args.info:
        return cmd_info(api, key, address)

    if args.send is not None:
        if not args.to:
            print("--send needs --to <address>")
            return 1
        return cmd_send(api, key, address, args.send, args.to, args.memo)

    # mining
    st = api.state(address)
    if not st.get("ok"):
        print("chain offline at %s -- %s" % (args.api, st.get("error")))
        print("check the url (--api) or deploy the backend (see DEPLOY.md)")
        return 1
    c = st["chain"]
    params = {"salt": c["salt"], "difficulty": c["difficulty"], "treasure": c["treasureKxi"]}
    totals = {"hashes": 0, "hits": 0, "credited": 0.0, "rate": 0.0,
              "balance": st.get("wallet", {}).get("balanceKxi", 0),
              "left": c["remainingKxi"], "height": c["height"], "hunters": 0}

    r = api.register(key)
    if not r.get("ok"):
        print("wallet registration failed: %s" % r.get("error"))
        return 1

    args.mode = "gpu" if args.gpu else "cpu"
    threads = args.threads or max(1, (os.cpu_count() or 2) - 1)
    totals["threads"] = threads

    banner("%s%s" % (args.mode.upper(),
                     " x%d" % threads if args.mode == "cpu" else ""))
    print("wallet  : %s  %s" % (address, "(new -- key in %s)" % args.wallet if not args.key else ""))
    print("backend : %s" % args.api)
    print("chain   : block %d  |  %.1f KXI left  |  treasure %.3f  |  diff %d"
          % (c["height"], c["remainingKxi"], c["treasureKxi"], c["difficulty"]))
    print("ctrl-c to stop. import the wallet key on the site to use coins in a browser.")
    print()

    disp = Display()
    drained = False
    try:
        if args.gpu:
            try:
                gpu_loop(api, key, address, params, args, disp, totals)
            except ModuleNotFoundError as e:
                print("\ngpu mode unavailable (%s)" % e)
                print("install it and retry:  pip install pyopencl numpy")
                print("falling back to cpu...\n")
                args.mode = "cpu"
                args.gpu = False
                totals["threads"] = threads
                cpu_loop(api, key, address, params, args, disp, totals)
            except RuntimeError as e:
                print("\nfatal: %s" % e)
                return 1
        else:
            cpu_loop(api, key, address, params, args, disp, totals)
    except Drained:
        drained = True
    except KeyboardInterrupt:
        pass
    print()
    if drained:
        print("CHAIN DRAINED -- all coins have been found. the hunt is over.")
    print("session : %s hashes  |  %d treasures  |  +%.3f KXI  |  balance %.3f KXI"
          % (fmt_int(totals["hashes"]), totals["hits"], totals["credited"], totals["balance"]))
    print("wallet  : %s" % address)
    return 0


if __name__ == "__main__":
    sys.exit(main())

