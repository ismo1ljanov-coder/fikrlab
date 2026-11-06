# Fikrlab — tez o‘qish mashq xonasi (Telegram mini app)

PDF kitob o‘qish, diagnostika, 1–2-modul mashqlari, ustoz rejimi va uyga vazifalar. Vaqt, bet va testlar avtomatik va halol hisoblanadi.

- `web/index.html` — butun ilova (bitta fayl). Telegram ichida server API bilan, claude.ai’da artifact sifatida ishlaydi.
- `server.js` — Node server: Telegram initData tekshiruvi, Neon Postgres, Claude bilan test tuzish, javoblarni serverda tekshirish, bot webhook (/start).
- `public/` — eski statik sayt: yangi manzilga yo‘naltiradi. `public/v1.html` — oldingi trenajyorlar.

## Halollik qoidalari (serverda)
- Yakunlangan yozuvni o‘zgartirib bo‘lmaydi; faol vaqt kamaymaydi va o‘tgan real vaqtdan oshmaydi.
- Test javoblari serverda saqlanadi va tekshiriladi; bitta test faqat bitta mashg‘ulotni tasdiqlaydi.
- Birinchi kirgan foydalanuvchi — ustoz (yoki `TEACHER_IDS`).

## Render (fikrlab-app, web service)
Build: `npm install`, start: `node server.js`.
Env: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, ixtiyoriy `TEACHER_IDS`, `QUIZ_MODEL`.
