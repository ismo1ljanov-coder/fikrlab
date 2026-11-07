#!/usr/bin/env bash
# Eski statik sayt (fikrlab.onrender.com) build paytida ishlaydi — bot tokeni shu yerda turadi.
# 1) public/bot.json ga bot ID va username yoziladi (ochiq ma'lumot, server Ed25519 tekshiruvi uchun oladi)
# 2) Bot menyu tugmasi yangi ilovaga ulanadi: fikrlab-app
set -u
APP="https://fikrlab-app.onrender.com"
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then echo "TELEGRAM_BOT_TOKEN yo'q — o'tkazib yuborildi"; exit 0; fi
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
ME=$(curl -s "$API/getMe")
ID=$(echo "$ME" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
USERNAME=$(echo "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
if [ -n "$ID" ]; then
  printf '{"id":%s,"username":"%s"}\n' "$ID" "$USERNAME" > public/bot.json
  echo "Bot: @$USERNAME ($ID)"
fi
curl -s -X POST "$API/setChatMenuButton" -H 'Content-Type: application/json' \
  -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Fikrlab\",\"web_app\":{\"url\":\"$APP\"}}}"; echo
curl -s -X POST "$API/setMyDescription" -H 'Content-Type: application/json' \
  -d '{"description":"Fikrlab — tez o‘qish mashq xonasi: PDF kitob o‘qish, diagnostika, Shulte, sakkad va boshqa mashqlar. Natijalar halol hisoblanadi. Pastdagi «Fikrlab» tugmasini bosing."}'; echo
curl -s -X POST "$API/setMyShortDescription" -H 'Content-Type: application/json' \
  -d '{"short_description":"Tez o‘qish mashq xonasi 📖"}'; echo
exit 0
