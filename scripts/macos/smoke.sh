#!/bin/bash
# Смоук-тест стенда на macOS: работает ли стенд на этой машине так, как в
# кампании. Не готовит ОС и не требует закоммиченного кода; данные пишет во
# временную папку и для анализа их не использует. ≈ 10 мин (на M4 — 8).
#
#   1) Node.js ≥ 22.12, зависимости, браузеры пула (нужна сеть);
#   2) typecheck и production-сборка;
#   3) packages/harness/src/smoke.ts: Chromium, Firefox — S1–S5,
#      WebKit — S2–S4; по одному прогону на ячейку, короткие окна;
#      проверка результата (паритет, условия страницы, формат CSV).
#
#   scripts/macos/smoke.sh                                 # всё
#   scripts/macos/smoke.sh --browser firefox --scenario s2,s4
#   scripts/macos/smoke.sh --keep                          # не удалять данные
#   scripts/macos/smoke.sh --offline                       # без npm и загрузки браузеров
#
# Код выхода 0 — все проверки пройдены.
set -euo pipefail
cd "$(dirname "$0")/../.."

OFFLINE=0
ARGS=()
for a in "$@"; do
  if [[ $a == --offline ]]; then OFFLINE=1; else ARGS+=("$a"); fi
done

step() { printf '\n[smoke] %s\n' "$1"; }

step "Node.js"
NODE_VERSION=$(node -p 'process.versions.node' 2>/dev/null) || { echo "Node.js не найден — нужен ≥ 22.12"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || { echo "Node.js $NODE_VERSION — нужен ≥ 22.12"; exit 1; }
echo "Node.js $NODE_VERSION"

if [[ $OFFLINE == 0 ]]; then
  step "зависимости и браузеры пула"
  [[ -d node_modules ]] || npm ci
  npm run --silent browsers
fi

step "typecheck"
npm run --silent typecheck

step "production-сборка"
npm run --silent build >/dev/null
echo "собрано"

step "прогоны"
node node_modules/tsx/dist/cli.mjs packages/harness/src/smoke.ts "${ARGS[@]+"${ARGS[@]}"}"
