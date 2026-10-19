#!/usr/bin/env bash
# Раскатка trafmix в одну команду:
#   bash <(curl -fsSL https://raw.githubusercontent.com/PonomarevAleksandr/trafmix/main/get.sh)
# Или сразу роль:
#   ... get.sh) panel     # панель (контроллер)
#   ... get.sh) node      # нода на тестовый сервер
set -euo pipefail
REPO="https://github.com/PonomarevAleksandr/trafmix"

have() { command -v "$1" >/dev/null 2>&1; }
ensure() {
  have "$1" && return 0
  echo "· ставлю $1…"
  if   have apt-get; then sudo apt-get update -qq && sudo apt-get install -y -qq "$1"
  elif have dnf;     then sudo dnf install -y "$1"
  elif have yum;     then sudo yum install -y "$1"
  elif have brew;    then brew install "$1"
  else echo "  поставь $1 сам и повтори"; exit 1; fi
}

if [ "$(id -u)" = 0 ]; then DIR=/opt/trafmix; else DIR="$HOME/trafmix"; fi

ensure git
echo "· код → $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q "$REPO" "$DIR"; fi
cd "$DIR"

role="${1:-}"
if [ -z "$role" ] && [ -r /dev/tty ]; then
  echo
  echo "Что ставим на этой машине?"
  echo "  1) панель  — контроллер, откуда рулишь (малинка / любой Ubuntu)"
  echo "  2) нода    — тестовый сервер, на который гоняем трафик"
  printf "Выбор [1/2]: "
  read -r a </dev/tty; [ "$a" = 2 ] && role=node || role=panel
fi
role="${role:-panel}"

case "$role" in
  panel|service|up)
    ./trafmix service
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo
    echo "✓ Панель поднята:  http://${IP:-<этот-IP>}:8744"
    echo "  → открой её, нажми «+ сервер» и добавь свои ноды"
    echo "    (адрес ноды, порт 5201, URL http://<IP-ноды>:8745/file)"
    echo "  ⚠ у панели нет своей авторизации — держи её за VPN/прокси или на внутреннем IP" ;;
  node)
    ./trafmix node
    echo
    echo "✓ Нода готова. Впиши её в панели кнопкой «+ сервер»." ;;
  *)
    echo "не понял роль «$role» — бывает panel или node"; exit 1 ;;
esac
