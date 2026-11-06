# Fikrlab — Telegram mini app

Tez o‘qish trenajyorlari (Schulte, nuqta, ko‘rish maydoni, so‘z, matn+tushunish, xotira) Telegram mini app ko‘rinishida.

- `public/index.html` — butun ilova (bitta fayl). Telegram WebApp SDK: mavzu ranglari, BackButton, haptika, CloudStorage’da natijalar.
- `scripts/setup-bot.sh` — Render build paytida bot menyu tugmasini sayt URL’iga ulaydi.

## Render
Static site, build command: `bash scripts/setup-bot.sh`, publish path: `public`.
Env: `TELEGRAM_BOT_TOKEN` (repoga yozilmaydi).
