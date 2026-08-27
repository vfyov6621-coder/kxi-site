#!/usr/bin/env bash
# kxi — publish: приватный репозиторий (исходники) + публичное зеркало (GitHub Pages)
# использование:  ./publish.sh
set -euo pipefail
cd "$(dirname "$0")"

git push origin main
git push pages main

echo "DONE — https://kxi.kixprojects.online пересоберётся через ~1 минуту"
