# kxi_

> FIND THE TOKEN IN THE CHAOS

Brutalist single-page site for **kxi** — a brute-force blockchain where mining
is a treasure hunt: tokens are scattered across hash space and found by
brute-force search.

## Stack

- Pure HTML / CSS / JS — no frameworks, no build step
- Inter (headlines) + JetBrains Mono (data) via Google Fonts, monospace/sans fallbacks
- Everything else is local — open `index.html` and go

## Structure

| File          | Role                                                            |
| ------------- | --------------------------------------------------------------- |
| `index.html`  | Layout: header / hero / mining terminal / buy / explorer / footer |
| `style.css`   | Strict black & white system: 1px hairlines, inversions, grain   |
| `script.js`   | Hash streaming, odometer counters, buy calculator, live explorer |

## Sections

1. **Header** — fixed, logo left, nav (Mining / Buy / Explorer), Connect Wallet right
2. **Hero** — "FIND THE TOKEN IN THE CHAOS" + one-line live stats bar (odometers)
3. **Mining terminal** — streaming random hashes, wallet input, blinking SEARCHING_
4. **Buy** — KXI/RUB · KXI/USD · KXI/BTC rates table, amount input, BUY button
5. **Explorer** — raw tables of latest blocks & transactions, monospace hashes
6. **Footer** — logo, year, docs link

## Run locally

```
python3 -m http.server 8000
# → http://localhost:8000
```

or just open `index.html` in a browser.

## Design rules

Zero color. Zero gradients. Zero shadows. Zero rounded corners. Zero emoji.
Typography over graphics. Hover = inversion (white ↔ black).
