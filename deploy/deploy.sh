#!/usr/bin/env bash
# Выкладка на пражский сервер. Запуск с Мака: deploy/deploy.sh
# Код копируется rsync (без git на сервере), секреты остаются в /etc/pngify-bot.env и сюда не попадают.
set -euo pipefail
HOST="${PNGIFY_HOST:?задай PNGIFY_HOST=root@<адрес из реестра серверов>}"
KEY="${PNGIFY_KEY:-$HOME/.secrets/vpn-stanok-deploy}"
cd "$(dirname "$0")/.."

npx tsc --noEmit
npm test --silent

rsync -az --delete -e "ssh -i $KEY" \
  --exclude node_modules --exclude .git --exclude .env --exclude '*.env' \
  ./ "$HOST:/opt/pngify-bot/"

ssh -i "$KEY" "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/pngify-bot
npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent
chown -R root:root /opt/pngify-bot && chmod -R a+rX /opt/pngify-bot
install -d -o pngify -g pngify -m 700 /var/lib/pngify /var/lib/pngify/jobs
install -m 644 deploy/pngify-bot.service /etc/systemd/system/pngify-bot.service
systemctl daemon-reload
systemctl enable --now pngify-bot >/dev/null
systemctl restart pngify-bot
sleep 4
systemctl is-active pngify-bot
journalctl -u pngify-bot -n 5 --no-pager -o cat
REMOTE
