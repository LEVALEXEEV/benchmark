#!/bin/bash
# Возвращает настройки, изменённые prepare-os.sh, к сохранённому состоянию.
# Безопасно запускать повторно и вручную (например, после сбоя питания).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Нужен sudo: sudo $0"; exit 1; }
STATE="$(cd "$(dirname "$0")/.." && pwd)/.os-state-macos"
[[ -f $STATE ]] || { echo "Нечего возвращать: $STATE нет"; exit 0; }
# shellcheck disable=SC1090
source "$STATE"

[[ $spotlight == on ]] && mdutil -a -i on >/dev/null && echo "Spotlight: индексация включена"
[[ $timemachine == 1 ]] && tmutil enable && echo "Time Machine: включена"
[[ $swcheck != 0 ]] && defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool true && echo "Обновления: автопроверка включена"
if [[ $appnap == unset ]]; then
  sudo -u "$user" defaults delete NSGlobalDomain NSAppSleepDisabled 2>/dev/null || true
else
  sudo -u "$user" defaults write NSGlobalDomain NSAppSleepDisabled -int "$appnap"
fi
echo "App Nap: исходная настройка возвращена"
if [[ $keep_network == 0 && $wifi == On ]]; then
  networksetup -setairportpower "$wifi_dev" on && echo "Wi-Fi ($wifi_dev): включён"
fi
rm -f "$STATE"
echo "Настройки macOS восстановлены"
