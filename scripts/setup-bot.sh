#!/usr/bin/env bash
# Render build paytida ishlaydi: bot menyu tugmasini mini app'ga ulaydi.
# Kerakli env: TELEGRAM_BOT_TOKEN. URL: RENDER_EXTERNAL_URL yoki APP_URL.
set -u
URL="${RENDER_EXTERNAL_URL:-${APP_URL:-}}"
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "$URL" ]; then
  echo "TELEGRAM_BOT_TOKEN yoki URL yo'q — bot sozlash o'tkazib yuborildi"; exit 0
fi
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

# Bot username'ni olib, ulashish havolasi uchun sahifaga yozamiz
USERNAME=$(curl -s "$API/getMe" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
if [ -n "$USERNAME" ]; then
  sed -i "s#<script src=\"https://telegram.org/js/telegram-web-app.js\"></script>#<script src=\"https://telegram.org/js/telegram-web-app.js\"></script><script>window.BOT_USERNAME='${USERNAME}'</script>#" public/index.html
  echo "Bot: @$USERNAME"
fi

# Menyu tugmasi -> mini app
curl -s -X POST "$API/setChatMenuButton" -H 'Content-Type: application/json' \
  -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Fikrlab\",\"web_app\":{\"url\":\"$URL\"}}}"; echo

# Bot tavsifi
curl -s -X POST "$API/setMyDescription" -H 'Content-Type: application/json' \
  -d '{"description":"Fikrlab — tez o‘qish trenajyorlari: Schulte jadvali, ko‘rish maydoni, xotira va tushunish mashqlari. Pastdagi «Fikrlab» tugmasini bosing."}'; echo
curl -s -X POST "$API/setMyShortDescription" -H 'Content-Type: application/json' \
  -d '{"short_description":"Tez o‘qish va xotira trenajyorlari 📖"}'; echo
exit 0
