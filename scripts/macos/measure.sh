#!/bin/bash
# Кампания замеров на macOS «от и до»:
#   1) проверки и подготовка стенда (git, браузеры пула, typecheck, сборка) —
#      пока есть сеть;
#   2) подготовка ОС (prepare-os.sh, нужен пароль администратора);
#   3) чек-лист, пауза 10 мин без нагрузки, все серии по матрице пула;
#      caffeinate не даёт уснуть системе и погаснуть экрану (иначе браузер
#      перестаёт рисовать кадры);
#   4) откат настроек ОС — при любом завершении, в том числе по Ctrl+C.
#
#   scripts/macos/measure.sh r2                      # вся кампания
#   scripts/macos/measure.sh r2 --filter chromium/base
#   scripts/macos/measure.sh r2b --keep-network      # не выключать Wi-Fi
#
# Прерванную кампанию можно запустить той же командой: готовые серии
# пропускаются. План и прогресс: npm run campaign -- list --session r2
set -euo pipefail
SESSION=${1:?"Использование: scripts/macos/measure.sh r2|r2b [--filter …] [--optional] [--keep-network]"}
shift
PREP_ARGS=()
RUN_ARGS=()
for a in "$@"; do
  if [[ $a == --keep-network ]]; then PREP_ARGS+=("$a"); else RUN_ARGS+=("$a"); fi
done
cd "$(dirname "$0")/../.."

npm run campaign -- prepare --session "$SESSION"

sudo -v
# sudo нужен и в конце, для отката, — держим его активным всю кампанию
( while kill -0 $$ 2>/dev/null; do sudo -n true; sleep 50; done ) &
KEEPALIVE=$!
restore() {
  sudo scripts/macos/restore-os.sh || echo "ВНИМАНИЕ: откат не выполнен — запустите sudo scripts/macos/restore-os.sh"
  kill "$KEEPALIVE" 2>/dev/null || true
}
trap restore EXIT
sudo scripts/macos/prepare-os.sh "${PREP_ARGS[@]+"${PREP_ARGS[@]}"}"

caffeinate -dims npm run campaign -- run --session "$SESSION" "${RUN_ARGS[@]+"${RUN_ARGS[@]}"}"
