#!/bin/bash
# Подготовка macOS к кампании замеров: выключает то, что создаёт фоновую
# нагрузку (индексация Spotlight, Time Machine, автопроверка обновлений,
# Wi-Fi — через него идут iCloud, обновления и уведомления; стенду сеть не
# нужна, всё через localhost). Исходное состояние сохраняется в файл, и
# restore-os.sh возвращает ровно его. Запуск: sudo scripts/macos/prepare-os.sh
# [--keep-network]. Показания машины не снимаются — меняются только настройки.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Нужен sudo: sudo $0 $*"; exit 1; }
STATE="$(cd "$(dirname "$0")/.." && pwd)/.os-state-macos"
[[ -f $STATE ]] && { echo "Уже подготовлено ($STATE). Сначала sudo scripts/macos/restore-os.sh"; exit 1; }
KEEP_NETWORK=0
[[ ${1:-} == --keep-network ]] && KEEP_NETWORK=1

spotlight=off
mdutil -s / 2>/dev/null | grep -q "Indexing enabled" && spotlight=on
timemachine=$(defaults read /Library/Preferences/com.apple.TimeMachine AutoBackup 2>/dev/null || echo 0)
swcheck=$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled 2>/dev/null || echo 1)
wifi_dev=$(networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}')
wifi=Off
[[ -n $wifi_dev ]] && wifi=$(networksetup -getairportpower "$wifi_dev" | awk '{print $NF}')
# App Nap — настройка пользователя (скрипт идёт под sudo, поэтому от его имени):
# усыплённый в фоне терминал замедлил бы harness и серверы vite preview,
# которые отдают бандл в S3
user=${SUDO_USER:-$USER}
appnap=$(sudo -u "$user" defaults read NSGlobalDomain NSAppSleepDisabled 2>/dev/null || echo unset)

# сначала состояние, потом изменения: откат возможен, даже если скрипт упадёт на середине
cat > "$STATE" <<STATE_EOF
spotlight=$spotlight
timemachine=$timemachine
swcheck=$swcheck
wifi_dev=$wifi_dev
wifi=$wifi
keep_network=$KEEP_NETWORK
user=$user
appnap=$appnap
STATE_EOF

[[ $spotlight == on ]] && mdutil -a -i off >/dev/null && echo "Spotlight: индексация выключена"
[[ $timemachine == 1 ]] && tmutil disable && echo "Time Machine: автоматическое копирование выключено"
[[ $swcheck != 0 ]] && defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool false && echo "Обновления: автопроверка выключена"
sudo -u "$user" defaults write NSGlobalDomain NSAppSleepDisabled -bool YES && echo "App Nap: выключен"
if [[ $KEEP_NETWORK == 0 && $wifi == On ]]; then
  networksetup -setairportpower "$wifi_dev" off && echo "Wi-Fi ($wifi_dev): выключен"
fi
echo "Готово. Откат: sudo scripts/macos/restore-os.sh"
