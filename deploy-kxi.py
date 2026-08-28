#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""deploy-kxi — поднимает бэкенд kxi на Cloudflare БЕСПЛАТНО, одной командой.

Запускать НА СВОЁМ КОМПЬЮТЕРЕ (IP уже разрешён в токене):

    python deploy-kxi.py <CLOUDFLARE_API_TOKEN>

Что делает (pure python, никаких зависимостей):
  1. проверяет токен, находит аккаунт
  2. создаёт базу D1 "kxi-chain" (если ещё нет)
  3. скачивает код бэкенда из публичного репозитория kxi-site
  4. заливает его как Worker "kxi-chain-api" с привязкой D1 и параметрами цепочки
  5. включает адрес kxi-chain-api.<поддомен>.workers.dev
  6. проверяет живой API

Результат: адрес бэкенда + админ-ключ (сохраняются в kxi-deploy-info.json).
"""
import argparse
import json
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.cloudflare.com/client/v4"
REPO_RAW = "https://raw.githubusercontent.com/vfyov6621-coder/kxi-site/main"
WORKER_NAME = "kxi-chain-api"
DB_NAME = "kxi-chain"
COMPAT_DATE = "2024-09-23"


def cf(token, method, path, body=None, ctype="application/json", raw=False):
    url = API + path
    data = None
    headers = {"Authorization": "Bearer " + token}
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
        elif isinstance(body, str):
            data = body.encode()
        else:
            data = body
        headers["Content-Type"] = ctype
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"success": False, "errors": [{"message": "HTTP %d" % e.code}]}
    except Exception as e:
        return 0, {"success": False, "errors": [{"message": str(e)}]}


def download(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("token", help="Cloudflare API token")
    ap.add_argument("--supply", default="1000", help="total supply KXI (default 1000)")
    ap.add_argument("--treasure", default="0.5", help="KXI per treasure (default 0.5)")
    ap.add_argument("--difficulty", default="7", help="leading hex zeros 1..8 (default 7)")
    ap.add_argument("--admin-key", help="admin key for /api/admin (default: random)")
    args = ap.parse_args()

    print("kxi backend deploy — Cloudflare free tier")
    print()

    # 1. account
    code, body = cf(args.token, "GET", "/accounts")
    if code != 200 or not body.get("success"):
        errs = "; ".join(x.get("message", "?") for x in body.get("errors", [])) or "HTTP %s" % code
        print("FAIL: token rejected -> %s" % errs)
        print("(запусти скрипт с того IP, который разрешён в токене)")
        sys.exit(1)
    acc = body["result"][0]
    acc_id = acc["id"]
    print("account : %s (%s)" % (acc["name"], acc_id))

    # 2. D1 database
    code, body = cf(args.token, "GET", "/accounts/%s/d1/database" % acc_id)
    db_id = None
    if code == 200 and body.get("success"):
        for db in body.get("result", []):
            if db.get("name") == DB_NAME:
                db_id = db["uuid"]
                print("d1      : found existing %s (%s)" % (DB_NAME, db_id))
    if not db_id:
        code, body = cf(args.token, "POST", "/accounts/%s/d1/database" % acc_id,
                        {"name": DB_NAME})
        if code != 200 or not body.get("success"):
            errs = "; ".join(x.get("message", "?") for x in body.get("errors", [])) or "HTTP %s" % code
            print("FAIL: d1 create -> %s" % errs)
            sys.exit(1)
        db_id = body["result"]["uuid"]
        print("d1      : created %s (%s)" % (DB_NAME, db_id))

    # 3. backend code from the public repo
    print("code    : downloading backend from kxi-site repo…")
    try:
        entry = download(REPO_RAW + "/worker/index.js")
        api_mod = download(REPO_RAW + "/functions/api/%5B%5Bpath%5D.js")
    except Exception as e:
        print("FAIL: cannot download backend code: %s" % e)
        sys.exit(1)
    print("code    : %d + %d bytes" % (len(entry), len(api_mod)))

    admin_key = args.admin_key or secrets.token_hex(16)

    # 4. worker upload (multipart, modules API)
    metadata = {
        "main_module": "worker/index.js",
        "compatibility_date": COMPAT_DATE,
        "bindings": [
            {"type": "d1", "name": "DB", "id": db_id, "database_name": DB_NAME},
            {"type": "plain_text", "name": "TOTAL_SUPPLY_KXI", "text": args.supply},
            {"type": "plain_text", "name": "TREASURE_KXI", "text": args.treasure},
            {"type": "plain_text", "name": "DIFFICULTY", "text": args.difficulty},
            {"type": "plain_text", "name": "ADMIN_KEY", "text": admin_key},
        ],
    }
    boundary = "----kxideploy" + secrets.token_hex(12)
    parts = []
    parts.append((
        'form-data; name="metadata"',
        "application/json",
        json.dumps(metadata).encode(),
    ))
    parts.append((
        'form-data; name="worker/index.js"; filename="worker/index.js"',
        "application/javascript+module",
        entry,
    ))
    parts.append((
        'form-data; name="functions/api/[[path]].js"; filename="functions/api/[[path]].js"',
        "application/javascript+module",
        api_mod,
    ))
    body_bytes = b""
    for disp, ctype, content in parts:
        body_bytes += ("--%s\r\n" % boundary).encode()
        body_bytes += ("Content-Disposition: %s\r\n" % disp).encode()
        body_bytes += ("Content-Type: %s\r\n\r\n" % ctype).encode()
        body_bytes += content + b"\r\n"
    body_bytes += ("--%s--\r\n" % boundary).encode()

    print("worker  : uploading %s (d1 bound, supply %s, treasure %s, difficulty %s)…"
          % (WORKER_NAME, args.supply, args.treasure, args.difficulty))
    code, wbody = cf(args.token, "PUT", "/accounts/%s/workers/scripts/%s" % (acc_id, WORKER_NAME),
                     body_bytes, ctype="multipart/form-data; boundary=" + boundary)
    if code != 200 or not wbody.get("success"):
        errs = "; ".join(x.get("message", "?") for x in wbody.get("errors", [])) or "HTTP %s" % code
        print("FAIL: worker upload -> %s" % errs)
        sys.exit(1)
    print("worker  : uploaded")

    # 5. enable workers.dev route
    cf(args.token, "PUT", "/accounts/%s/workers/scripts/%s/subdomain" % (acc_id, WORKER_NAME),
       {"enabled": True, "previews_enabled": False})
    code, body = cf(args.token, "GET", "/accounts/%s/workers/subdomain" % acc_id)
    if code != 200 or not body.get("success"):
        print("FAIL: cannot read workers subdomain")
        sys.exit(1)
    sub = body["result"]["subdomain"]
    base = "https://%s.%s.workers.dev" % (WORKER_NAME, sub)
    print("url     : %s" % base)

    # 6. smoke test
    print("check   : waiting for /api/state…")
    ok = False
    state = None
    for i in range(30):
        try:
            with urllib.request.urlopen(base + "/api/state", timeout=20) as r:
                state = json.loads(r.read().decode())
                if state.get("ok"):
                    ok = True
                    break
        except Exception:
            pass
        time.sleep(3)
    if not ok:
        print("WARN    : /api/state not ready yet — подожди минуту и открой %s/api/state" % base)
    else:
        c = state["chain"]
        print("check   : LIVE — block %s, supply %s KXI, treasure %s, difficulty %s"
              % (c["height"], c["totalSupplyKxi"], c["treasureKxi"], c["difficulty"]))

    with open("kxi-deploy-info.json", "w") as f:
        json.dump({"backend": base, "admin_key": admin_key,
                   "supply": args.supply, "treasure": args.treasure,
                   "difficulty": args.difficulty}, f, indent=2)

    print()
    print("════════════════════════════════════════════════════════")
    print(" BACKEND : %s" % base)
    print(" ADMIN   : %s   (kxi-deploy-info.json)" % admin_key)
    print("════════════════════════════════════════════════════════")
    print()
    print("Пришли адрес BACKEND в чат — я подключу к нему сайт.")
    print("Проверка вручную: %s/api/state" % base)
    return 0


if __name__ == "__main__":
    sys.exit(main())
