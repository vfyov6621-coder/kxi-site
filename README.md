# kxi_

> FIND THE TOKEN IN THE CHAOS

Brutalist single-page site + backend for **kxi** — a brute-force blockchain
where mining is a treasure hunt: 1000 KXI are scattered across hash space
in 0.5-coin treasures and found by brute-force search.

**No fiat in, no fiat out.** Wallets are auto-issued in the browser on
visit, mining runs locally (Web Workers, pure-JS SHA-256 verified against
WebCrypto), and transfers live on-chain only (KXI → KXI). A **console
miner** (`kxi-miner.py`) mines from the terminal — CPU multiprocess or
GPU via OpenCL, like bitcoin in the old days.

## Stack

- Frontend: pure HTML / CSS / JS — no frameworks, no build step
- Backend: Cloudflare Pages Functions + D1 SQLite (free tier, same origin)
- Inter (headlines) + JetBrains Mono (data) via Google Fonts

## Structure

| File                        | Role                                                       |
| --------------------------- | ---------------------------------------------------------- |
| `index.html`                | Layout: header / hero / mining / wallet & transfers / explorer / footer |
| `style.css`                 | Strict black & white system: 1px hairlines, inversions, grain |
| `script.js`                 | Auto-wallet, API layer, mining workers, transfers, live explorer |
| `miner.js`                  | Web Worker: pure-JS SHA-256 + brute-force nonce loop (self-tested vs WebCrypto) |
| `kxi-miner.py`              | Console miner: CPU multiprocess + GPU (OpenCL kernel, gcc-verified), transfers, benchmark |
| `functions/api/[[path]].js` | Backend: wallets, claims (PoW verification), transfers, blocks, admin |
| `worker/index.js`           | Standalone Worker entry (same backend code, Workers deploy path)   |
| `schema.sql`                | D1 schema reference + reset tool                           |
| `wrangler.toml.example`     | Optional CLI deploy config                                 |
| `DEPLOY.md`                 | **Free backend deploy guide (Cloudflare, RU)**             |
| `publish.sh`                | Publish: push to private repo + public Pages mirror        |
| `CNAME`                     | Custom domain (kxi.kixprojects.online)                     |

## Protocol

1. Genesis places `TOTAL_SUPPLY_KXI` (default 1000) as treasures of
   `TREASURE_KXI` (default 0.5) each.
2. A treasure nonce is any 12-hex-char nonce whose `sha256("salt:nonce")`
   starts with `DIFFICULTY` (default 7) zero hex chars.
3. The browser (or the console miner) brute-forces nonces locally; on a hit
   it submits the proof.
4. The server recomputes the hash, checks the nonce is unclaimed and supply
   remains, then credits the first hunter. One nonce = one treasure.
5. Transfers move KXI between on-chain wallets in a single D1 transaction
   with guarded writes (no double-spend).

## Console miner

```
curl -O https://kxi.kixprojects.online/kxi-miner.py
python kxi-miner.py                # cpu, wallet auto-created
python kxi-miner.py --gpu          # opencl gpu
python kxi-miner.py --benchmark    # measure hashrate
python kxi-miner.py --send 0.5 --to 0x…
```

## Run locally

Static only (chain offline banner expected):

```
python3 -m http.server 8000
```

Full stack (frontend + backend over node:sqlite shim):

```
node scripts/e2e-server.mjs   # → http://127.0.0.1:8787 (difficulty 5)
```

Tests:

```
node scripts/test-miner-sha.mjs   # miner SHA-256 vs node:crypto (40k+ inputs)
node scripts/test-api.mjs         # full API suite: claims, transfers, races, admin
node scripts/test-kernel.mjs     # GPU kernel SHA-256 vs node:crypto (gcc build)
```

## Deploy

Frontend: push to `main` (GitHub Pages / Cloudflare Pages rebuilds).
Backend (free, same domain): follow **DEPLOY.md** — Cloudflare Pages
project + D1 binding `DB` + env vars. ~10 minutes, zero cost.

## Design rules

Zero color. Zero gradients. Zero shadows. Zero rounded corners. Zero emoji.
Typography over graphics. Hover = inversion (white ↔ black).
