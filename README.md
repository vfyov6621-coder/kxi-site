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

| File             | Role                                                              |
| ---------------- | ----------------------------------------------------------------- |
| `index.html`     | Layout: header / hero / mining terminal / buy / explorer / footer |
| `style.css`      | Strict black & white system: 1px hairlines, inversions, grain     |
| `script.js`      | Hash streaming, odometers, buy calculator, live explorer          |
| `publish.sh`     | Publish: push to private repo + public Pages mirror               |
| `CNAME`          | GitHub Pages custom domain (kxi.kixprojects.online)               |
| `deploy/`        | Backend configs: nginx reverse proxy + systemd unit               |

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

---

## Деплой — kxi.kixprojects.online

Схема из двух репозиториев (на бесплатном GitHub Pages публикуется только из
публичных репо):

| Репозиторий                | Видимость | Роль                              |
| -------------------------- | --------- | --------------------------------- |
| `vfyov6621-coder/kxi`      | private   | исходники — правки делаешь здесь  |
| `vfyov6621-coder/kxi-site` | public    | live-зеркало — его публикует Pages |

На `kxi-site` включён GitHub Pages (ветка `main`, корень репо) с custom domain
`kxi.kixprojects.online` (файл `CNAME` в корне). DNS уже настроен со стороны
домена: `kxi.kixprojects.online` → CNAME → `vfyov6621-coder.github.io`.

Публикация изменений:

```bash
./publish.sh   # push в приватный kxi, затем в публичный kxi-site → Pages пересоберётся (~1 мин)
```

Ручной эквивалент:

```bash
git push origin main
git push pages main
```

HTTPS: сертификат Let's Encrypt выдаётся GitHub'ом автоматически после привязки
домена. Проверить и включить: `kxi-site` → Settings → Pages → **Enforce HTTPS**.

## Бэкенд — куда ставить

GitHub Pages — только статика, поэтому бэкенд (нода kxi + API) живёт на VPS
в отдельном поддомене:

```
kxi.kixprojects.online      → GitHub Pages (этот репозиторий, статичный фронтенд)
api.kxi.kixprojects.online  → VPS: nginx → 127.0.0.1:8080 (нода/API kxi)
docs.kxi.kixprojects.online → (опционально) будущая документация
```

1. DNS (панель reg.ru): добавить A-запись `api.kxi` → IP вашего VPS.
2. Нода/API как systemd-сервис — готовый юнит: `deploy/kxi-api.service`.
3. nginx reverse proxy с поддержкой WebSocket — готовый конфиг: `deploy/nginx-api.conf`.
4. SSL: `sudo certbot --nginx -d api.kxi.kixprojects.online`.
5. CORS: разрешить origin `https://kxi.kixprojects.online`.
6. Точки интеграции во фронтенде помечены в `script.js` комментариями `[API:…]`
   (статы, live-поток проб, курсы, ордера, эксплорер).

Serverless не подходит: блокчейн-ноде нужен постоянный процесс и диск —
берите маленький always-on VPS (1–2 vCPU / 2 GB RAM).
