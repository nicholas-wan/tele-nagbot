#!/usr/bin/env bash
# Downloads the LatteMocha2 sticker pack into nag-bot/.claude/stickers/.
# Asks for the bot token (from @BotFather > /mybots > your bot > API Token) without echoing it,
# and keeps it only for this one command.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
read -rsp 'Paste the Nag-bot token from @BotFather (hidden), then press Enter: ' token
echo
if [ -z "$token" ]; then echo 'No token entered.'; exit 1; fi
BOT_TOKEN="$token" node "$here/get-sticker-pack.cjs"
