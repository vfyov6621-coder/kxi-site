# DEPLOY — бесплатный бэкенд для kxi (Cloudflare Pages + D1)

Фронтенд **и** бэкенд живут в этом одном репозитории. Статика — где сейчас
(GitHub Pages или Cloudflare Pages), API — функции Cloudflare Pages Functions
+ база D1. Оба тарифа бесплатные, без «засыпания» (в отличие от Render),
без кредитной карты.

```
kxi.kixprojects.online          → сайт (статика)
kxi.kixprojects.online/api/*    → бэкенд (Pages Functions + D1)  ← этот гайд
```

Что получится после деплоя: кошельки выдаются автоматически при заходе,
майнинг считает SHA-256 в браузере пользователя, сервер проверяет proof'ы
пересчётом хеша, переводы ходят только внутри цепочки KXI → KXI.

---

## Шаг 1 — аккаунт Cloudflare (2 минуты)

1. Открой https://dash.cloudflare.com/sign-up
2. Зарегистрируйся (email + пароль). Карта не нужна, план Free.

## Шаг 2 — подключить репозиторий к Pages (3 минуты)

1. Dashboard → **Workers & Pages** → **Create** → вкладка **Pages** →
   **Connect to Git**
2. Авторизуйся в GitHub, выбери репозиторий **kxi-site**
3. Настройки сборки:
   - Project name: `kxi-site`
   - Production branch: `main`
   - Framework preset: `None`
   - Build command: **оставить пустым**
   - Build output directory: `/`
4. **Save and Deploy** — задеплоится статика (API пока не работает).
   Сайт станет доступен по адресу `https://kxi-site.pages.dev`
   (имя зависит от Project name).

## Шаг 3 — создать базу D1 (1 минута)

1. Dashboard → **Storage & Databases** → **D1 SQL Database** → **Create**
2. Name: `kxi-chain` → Create. Бесплатный лимит: 5 ГБ, за глаза.

## Шаг 4 — привязать базу к функциям (1 минута)

1. Открой проект `kxi-site` → **Settings** → **Functions**
2. **D1 database bindings** → **Add binding**:
   - Variable name: `DB`  ← обязательно именно так
   - D1 database: `kxi-chain`
   - добавить для **Production** и **Preview**
3. Save.

## Шаг 5 — параметры цепочки (1 минута)

Там же: **Settings** → **Environment variables** → Add:

| Переменная         | Значение | Смысл                                    |
| ------------------ | -------- | ---------------------------------------- |
| `TOTAL_SUPPLY_KXI` | `1000`   | сколько монет размещено в цепочке        |
| `TREASURE_KXI`     | `0.5`    | размер одного сокровища                  |
| `DIFFICULTY`       | `6`      | сколько нулей в начале хеша (5–6 норм)   |
| `ADMIN_KEY`        | секрет   | пароль для /api/admin — придумай сам     |

Добавь переменные для Production → **Deployments** → последний деплой →
**⋯** → **Retry deployment** (переменные подхватываются только новым деплоем).

## Шаг 6 — домен kxi.kixprojects.online (2 минуты + DNS)

1. Проект `kxi-site` → **Custom domains** → **Set up a custom domain**
2. Введи `kxi.kixprojects.online` → Continue → Activate domain
3. Cloudflare попросит CNAME. Иди в панель **reg.ru** → DNS домена
   kixprojects.online → измени существующую запись:
   - `kxi` CNAME `vfyov6621-coder.github.io` → **заменить на** `kxi-site.pages.dev`
4. Вернись в Cloudflare → проверка пройдёт сама (~1–5 минут), SSL-сертификат
   выпустится автоматически.

После переключения DNS фронтенд можно полностью убрать с GitHub Pages:
репозиторий `kxi-site` → Settings → Pages → Source: **None**.
(Файл `CNAME` в репо Cloudflare не мешает — он игнорируется.)

> Альтернатива без смены DNS: оставить сайт на GitHub Pages, а API будет
> жить на `https://kxi-site.pages.dev` — CORS в бэкенде уже разрешён. Но
> тогда в `script.js` замени `const API = '/api'` на адрес с pages.dev.

## Шаг 7 — проверка

- Открой https://kxi.kixprojects.online — баннер «CHAIN OFFLINE» должен
  исчезнуть, hero-статы покажут Block 0 / 1000.0 / 0.
- Нажми **Start search** — в терминале пойдёт перебор хешей, через пару
  минут (difficulty 6) — первый `CLAIM CONFIRMED +0.500 KXI`.
- Проверка API напрямую: https://kxi.kixprojects.online/api/state

---

## Как это работает

- **Монеты.** При первом запросе цепочка «генезится»: TOTAL_SUPPLY KXI
  размещается сокровищами по TREASURE_KXI. 1000 / 0.5 = 2000 сокровищ.
- **Сокровище** = любой 12-символьный hex-нонс, у которого
  `sha256("salt:nonce")` начинается с DIFFICULTY нулей. Соль одна на всех,
  лежит в БД.
- **Майнинг локальный**: браузер перебирает нонсы в Web Worker'ах
  (свой SHA-256, самопроверка против WebCrypto при старте). Сервер ничего
  не считает — только пересчитывает один хеш присланного нонса и платит
  первому. Один нонс = одно сокровище (UNIQUE в БД).
- **Кошелёк** генерируется в браузере при заходе: secret → auth-key →
  адрес. Secret живёт в localStorage, его можно экспортировать/импортировать.
- **Переводы** только KXI → KXI между существующими кошельками, фиатных
  пополнений нет вообще. Списание и зачисление — одна транзакция D1 с
  guard-условиями (double-spend невозможен).
- **Блоки**: каждые 8 транзакций (или 60 сек) транзакции «запечатываются»
  в блок, хеши блоков сцеплены (`hash = sha256(height|prev|root|ts)`).

## Админ

```bash
# посмотреть состояние
curl -X POST https://kxi.kixprojects.online/api/admin \
  -H "x-kxi-admin: ВАШ_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"action":"info"}'

# сделать клады по 0.25 KXI
curl -X POST https://kxi.kixprojects.online/api/admin \
  -H "x-kxi-admin: ВАШ_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"action":"config","treasureKxi":0.25}'

# усложнить/упростить поиск (1..8 нулей)
curl -X POST https://kxi.kixprojects.online/api/admin \
  -H "x-kxi-admin: ВАШ_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"action":"config","difficulty":5}'

# докинуть монет
curl -X POST https://kxi.kixprojects.online/api/admin \
  -H "x-kxi-admin: ВАШ_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"action":"config","totalSupplyKxi":5000}'
```

Доступные действия: `info`, `config` (treasureKxi / difficulty /
totalSupplyKxi), `rotate-salt` (обнулить все ненайденные proof'ы).

## Сброс цепочки (D1 консоль)

Dashboard → D1 → `kxi-chain` → Console:

```sql
DELETE FROM claims; DELETE FROM txs; DELETE FROM blocks;
DELETE FROM wallets; DELETE FROM config;
```

Цепочка пересоздастся с нуля из переменных окружения при следующем запросе.

## Лимиты бесплатного тарифа

| Ресурс             | Лимит Free                  | Кому хватит                       |
| ------------------ | --------------------------- | --------------------------------- |
| Functions          | 100 000 запросов/день       | ~80 одновременных вкладок с поллингом 12 c |
| D1 чтение          | 25 млрд строк/мес           | с огромным запасом                |
| D1 запись          | 50 млн строк/мес            | с огромным запасом                |
| D1 хранение        | 5 ГБ                        | миллионы транзакций               |

Если сайт вырастет — Workers Paid ($5/мес) снимает лимиты.

## Почему не другое бесплатное

- **Render.com free** — засыпает через 15 мин простоя, холодный старт 30–60 c.
- **Fly.io** — нужна кредитная карта.
- **Supabase free** — проект ставится на паузу через неделю неактивности,
  восстановление вручную.
- **Cloudflare Pages + D1** — всегда готов (edge, без холодного старта),
  без карты, и API живёт на том же домене, что и сайт (никакого CORS).

Если очень нужен свой сервер — конфиги nginx+systemd для VPS убраны из
репо за ненадобностью;architecture описана в git-истории.
