// Fikrlab server: Telegram mini app + API + Neon Postgres + Claude testlari.
// Env: DATABASE_URL, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY (ixtiyoriy), TEACHER_IDS (ixtiyoriy, vergul bilan), QUIZ_MODEL (ixtiyoriy)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
let TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.QUIZ_MODEL || "claude-haiku-5-5";
const PUBLIC_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const BOT_INFO_URL = process.env.BOT_INFO_URL || "https://fikrlab.onrender.com/bot.json";
let BOT_ID = process.env.BOT_ID || (TOKEN ? TOKEN.split(":")[0] : "");
const TG_PUBKEY = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(process.env.TG_PUBKEY_HEX || "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d", "hex")]), format: "der", type: "spki" });
async function loadBotId() {
  if (BOT_ID) return;
  try { const r = await fetch(BOT_INFO_URL, { cache: "no-store" }); const j = await r.json(); if (j && /^\d+$/.test(String(j.id))) { BOT_ID = String(j.id); console.log("Bot ID topildi:", BOT_ID, j.username ? "@" + j.username : ""); return; } } catch (e) {}
  console.log("Bot ID hali yo‘q, 60 soniyadan keyin qayta urinaman");
  setTimeout(loadBotId, 60000);
}
const TEACHER_IDS = (process.env.TEACHER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const QUIZ_PER_DAY = 60;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost") ? { rejectUnauthorized: false } : false, max: 5 });
const q = (text, params = []) => pool.query(text, params).then(r => r.rows);

async function migrate() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (id BIGINT PRIMARY KEY, name TEXT, username TEXT, is_teacher BOOLEAN NOT NULL DEFAULT FALSE, joined_at BIGINT NOT NULL, last_seen BIGINT NOT NULL, sum JSONB)`,
    `CREATE TABLE IF NOT EXISTS books (user_id BIGINT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (user_id, id))`,
    `CREATE TABLE IF NOT EXISTS sessions (user_id BIGINT NOT NULL, id TEXT NOT NULL, start_ts BIGINT NOT NULL, data JSONB NOT NULL, received_at BIGINT NOT NULL, PRIMARY KEY (user_id, id))`,
    `CREATE INDEX IF NOT EXISTS sessions_user_start ON sessions (user_id, start_ts DESC)`,
    `CREATE TABLE IF NOT EXISTS homework (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_by BIGINT)`,
    `CREATE TABLE IF NOT EXISTS quizzes (id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, answers JSONB NOT NULL, picks JSONB NOT NULL, used_by TEXT, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  ];
  for (const s of stmts) await q(s);
  if (!TOKEN) { const r = await q(`SELECT value FROM settings WHERE key = 'bot_token'`); if (r.length) { TOKEN = r[0].value; console.log("Bot tokeni bazadan olindi"); } }
  if (TOKEN && !BOT_ID) BOT_ID = TOKEN.split(":")[0];
}

/* ---------- Telegram initData tekshiruvi ---------- */
function verifyInitData(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"), sig = p.get("signature");
  if (TOKEN && hash) {
    p.delete("hash");
    const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + "=" + v).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
    if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  } else if (BOT_ID && sig) {
    // Tokensiz tekshiruv: Telegram'ning Ed25519 imzosi (third-party validation)
    p.delete("hash"); p.delete("signature");
    const dcs = BOT_ID + ":WebAppData\n" + [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + "=" + v).join("\n");
    let ok = false;
    try { ok = crypto.verify(null, Buffer.from(dcs), TG_PUBKEY, Buffer.from(sig, "base64url")); } catch (e) { ok = false; }
    if (!ok) return null;
  } else return null;
  const auth = Number(p.get("auth_date") || 0);
  if (!auth || Date.now() / 1000 - auth > 7 * 86400) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

/* ---------- yordamchilar ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
const err = (res, status, code, error) => send(res, status, { code, error });
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too_large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("bad_json"), { status: 400 })); } });
    req.on("error", reject);
  });
}
const idOk = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s);
const json = v => JSON.stringify(v);
const parse = v => (typeof v === "string" ? JSON.parse(v) : v);

async function upsertUser(u) {
  const now = Date.now();
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 80) || (u.username ? "@" + u.username : "O‘quvchi");
  const rows = await q(`SELECT id, is_teacher FROM users WHERE id = $1`, [u.id]);
  if (!rows.length) {
    let teacher = TEACHER_IDS.includes(String(u.id));
    if (!TEACHER_IDS.length) { const t = await q(`SELECT id FROM users WHERE is_teacher = TRUE LIMIT 1`); teacher = !t.length; }
    await q(`INSERT INTO users (id, name, username, is_teacher, joined_at, last_seen) VALUES ($1,$2,$3,$4,$5,$6)`, [u.id, name, u.username || null, teacher, now, now]);
    return { id: u.id, isTeacher: teacher };
  }
  const teacher = TEACHER_IDS.length ? TEACHER_IDS.includes(String(u.id)) : !!rows[0].is_teacher;
  await q(`UPDATE users SET name = $2, username = $3, last_seen = $4, is_teacher = $5 WHERE id = $1`, [u.id, name, u.username || null, now, teacher]);
  return { id: u.id, isTeacher: teacher };
}

/* ---------- sessiya qoidalari (server tomonida) ---------- */
const KINDS = new Set(["read", "test", "tachisto", "periph", "palming", "shulte", "klin", "sakkad"]);
async function applyQuiz(userId, sessionId, data) {
  const quiz = data.quiz;
  if (!quiz || quiz.skipped || !quiz.quizId) {
    if (quiz && !quiz.skipped) data.quiz = { skipped: true, reason: "unverified" };
    if (data.kind === "test" && (!quiz || quiz.skipped || !quiz.quizId)) { data.comprehension = null; data.effective = null; }
    return;
  }
  const rows = await q(`SELECT answers, picks, used_by FROM quizzes WHERE id = $1 AND user_id = $2`, [quiz.quizId, userId]);
  if (!rows.length || (rows[0].used_by && rows[0].used_by !== sessionId)) { data.quiz = { skipped: true, reason: "invalid" }; data.comprehension = null; data.effective = null; return; }
  const answers = parse(rows[0].answers), picks = parse(rows[0].picks);
  const correct = answers.reduce((a, ans, i) => a + (picks[i] === ans ? 1 : 0), 0);
  data.quiz = { quizId: quiz.quizId, n: answers.length, correct, at: quiz.at || Date.now(), serverChecked: true };
  if (data.kind === "test" && typeof data.wpm === "number") { data.comprehension = correct / answers.length; data.effective = Math.round(data.wpm * data.comprehension); }
  if (!rows[0].used_by) await q(`UPDATE quizzes SET used_by = $2 WHERE id = $1`, [quiz.quizId, sessionId]);
}
async function putSession(userId, id, data, res, clientNow) {
  if (!data || typeof data !== "object" || !KINDS.has(data.kind)) return err(res, 400, "bad_kind", "Noma’lum yozuv turi.");
  const now = Date.now();
  // telefon soati noto‘g‘ri bo‘lishi mumkin: farqni hisobga olamiz
  let offset = Number(clientNow) ? now - Number(clientNow) : 0;
  if (!(Math.abs(offset) < 2 * 86400e3)) offset = 0;
  const start = Number(data.start), adjStart = start + offset;
  if (!(adjStart > now - 26 * 3600e3 && adjStart < now + 120e3)) return err(res, 422, "bad_time", "Yozuv vaqti noto‘g‘ri.");
  const prev = await q(`SELECT data FROM sessions WHERE user_id = $1 AND id = $2`, [userId, id]);
  if (prev.length) {
    const p = parse(prev[0].data);
    if (!(p.kind === "read" && p.status === "open")) return err(res, 409, "closed", "Yakunlangan yozuvni o‘zgartirib bo‘lmaydi.");
    if (data.kind !== "read" || Number(p.start) !== start) return err(res, 409, "mismatch", "Yozuvni boshqasiga almashtirib bo‘lmaydi.");
    if ((data.activeSec || 0) < (p.activeSec || 0)) return err(res, 422, "time_back", "Faol vaqt kamaya olmaydi.");
  }
  if (data.kind === "read") {
    const maxSec = Math.ceil((now - adjStart) / 1000) + 15;
    if ((data.activeSec || 0) > maxSec) return err(res, 422, "time_over", "Faol vaqt o‘tgan vaqtdan ko‘p bo‘lishi mumkin emas.");
  }
  if (typeof data.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.day)) data.day = new Date(start + 5 * 3600e3).toISOString().slice(0, 10);
  await applyQuiz(userId, id, data);
  data.receivedAt = now;
  await q(`INSERT INTO sessions (user_id, id, start_ts, data, received_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id, id) DO UPDATE SET data = EXCLUDED.data, received_at = EXCLUDED.received_at`, [userId, id, start, json(data), now]);
  send(res, 200, { ok: true, data });
}

/* ---------- Claude savollari ---------- */
const quizCount = new Map();
function quizPrompt(n, hasText) {
  return `Sen tez o‘qish kursi uchun tushunish testini tuzasan. Quyida o‘quvchi hozirgina o‘qigan matn (yoki sahifa rasmlari) berilgan.
Faqat shu matnda aniq aytilgan narsalar bo‘yicha ${n} ta savol tuz.
Qoidalar:
- Matnni o‘qimagan odam umumiy bilim bilan topa olmaydigan savollar bo‘lsin: voqea, ism, sabab-oqibat, raqam, asosiy fikr.
- Savollar matn bo‘ylab tarqalgan bo‘lsin (boshi, o‘rtasi, oxiri).
- Har bir savolda 4 ta qisqa variant, faqat bittasi to‘g‘ri. Tuzoq va ikki ma’noli savol bo‘lmasin.
- Til: o‘zbek tili, lotin yozuvi. Agar matn boshqa tilda bo‘lsa, savollarni matn tilida yoz.
Faqat JSON qaytar, boshqa hech narsa yozma:
{"questions":[{"q":"savol","options":["A","B","C","D"],"answer":0}]}
` + (hasText ? "" : "\nMatn rasmlarda berilgan.");
}
function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}
async function makeQuiz(userId, body, res) {
  if (!AI_KEY) return err(res, 503, "no_key", "Testlar hali yoqilmagan (ANTHROPIC_API_KEY yo‘q).");
  const day = new Date().toISOString().slice(0, 10), key = userId + ":" + day;
  const used = quizCount.get(key) || 0;
  if (used >= QUIZ_PER_DAY) return err(res, 429, "rate_limited", "Bugungi testlar limiti tugadi.");
  quizCount.set(key, used + 1);
  const n = Math.min(5, Math.max(2, Number(body.n) || 3));
  const text = typeof body.text === "string" ? body.text.slice(0, 9000) : "";
  const images = Array.isArray(body.images) ? body.images.slice(0, 2).filter(s => typeof s === "string" && s.length < 2_500_000) : [];
  if (text.trim().split(/\s+/).length < 20 && !images.length) return err(res, 400, "short", "Matn juda qisqa.");
  const content = images.map(b64 => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64.replace(/^data:image\/\w+;base64,/, "") } }));
  content.push({ type: "text", text: quizPrompt(n, !!text) + (text ? `\nMATN:\n"""\n${text}\n"""` : "") });
  let out;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1800, messages: [{ role: "user", content }] })
    });
    const j = await r.json();
    if (!r.ok) { console.error("anthropic", r.status, j && j.error); return err(res, 502, r.status === 429 ? "rate_limited" : "upstream_error", "Claude javob bermadi."); }
    out = extractJson((j.content || []).filter(c => c.type === "text").map(c => c.text).join(""));
  } catch (e) { console.error("anthropic fetch", e.message); return err(res, 502, "upstream_error", "Claude’ga ulanib bo‘lmadi."); }
  const raw = Array.isArray(out) ? out : out && Array.isArray(out.questions) ? out.questions : [];
  const qs = [], answers = [];
  for (const it of raw) {
    if (!it || typeof it.q !== "string" || !Array.isArray(it.options) || it.options.length < 3) continue;
    const ans = Number(it.answer); if (!(ans >= 0 && ans < it.options.length)) continue;
    const order = it.options.map((_, i) => i).sort(() => Math.random() - 0.5);
    qs.push({ q: it.q, options: order.map(i => String(it.options[i])) });
    answers.push(order.indexOf(ans));
    if (qs.length >= n) break;
  }
  if (qs.length < Math.min(2, n)) return err(res, 502, "bad_questions", "Savollar to‘g‘ri tuzilmadi.");
  const id = "q" + crypto.randomBytes(9).toString("hex");
  await q(`INSERT INTO quizzes (id, user_id, answers, picks, created_at) VALUES ($1,$2,$3,$4,$5)`, [id, userId, json(answers), json({}), Date.now()]);
  send(res, 200, { quizId: id, questions: qs });
}
async function answerQuiz(userId, id, body, res) {
  const rows = await q(`SELECT answers, picks, used_by FROM quizzes WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows.length) return err(res, 404, "no_quiz", "Test topilmadi.");
  if (rows[0].used_by) return err(res, 409, "used", "Bu test allaqachon yakunlangan.");
  const answers = parse(rows[0].answers), picks = parse(rows[0].picks);
  const qi = Number(body.qi), choice = Number(body.choice);
  if (!(qi >= 0 && qi < answers.length) || !(choice >= 0 && choice < 6)) return err(res, 400, "bad_answer", "Noto‘g‘ri javob.");
  if (picks[qi] === undefined) { picks[qi] = choice; await q(`UPDATE quizzes SET picks = $2 WHERE id = $1`, [id, json(picks)]); }
  send(res, 200, { right: picks[qi] === answers[qi], rightIndex: answers[qi], first: picks[qi] === choice });
}

/* ---------- API marshrutlari ---------- */
async function api(req, res, url) {
  const user = verifyInitData(req.headers["x-init-data"]);
  if (!user || !user.id) return err(res, 401, "auth", TOKEN || BOT_ID ? "Ilovani Telegram ichidan oching." : "Server hali bot bilan bog‘lanmadi. Bir daqiqadan keyin qayta oching.");
  const me = await upsertUser(user);
  const uid = me.id;
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
  const m = req.method;
  const body = m === "PUT" || m === "POST" ? await readBody(req) : null;

  if (m === "GET" && parts[0] === "me") return send(res, 200, { id: String(uid), isTeacher: me.isTeacher, quiz: !!AI_KEY });
  if (m === "GET" && parts[0] === "state") {
    const [books, sessions, homework] = await Promise.all([
      q(`SELECT id, data FROM books WHERE user_id = $1`, [uid]),
      q(`SELECT id, data FROM sessions WHERE user_id = $1 ORDER BY start_ts DESC LIMIT 1000`, [uid]),
      q(`SELECT id, data FROM homework`)
    ]);
    const u = await q(`SELECT joined_at FROM users WHERE id = $1`, [uid]);
    return send(res, 200, { books: books.map(r => ({ id: r.id, ...parse(r.data) })), sessions: sessions.map(r => ({ id: r.id, ...parse(r.data) })), homework: homework.map(r => ({ id: r.id, ...parse(r.data) })), joinedAt: u[0] && Number(u[0].joined_at) });
  }
  if (m === "PUT" && parts[0] === "books" && idOk(parts[1])) {
    const d = body && body.data; if (!d || typeof d !== "object") return err(res, 400, "bad", "Ma’lumot yo‘q.");
    await q(`INSERT INTO books (user_id, id, data) VALUES ($1,$2,$3) ON CONFLICT (user_id, id) DO UPDATE SET data = EXCLUDED.data`, [uid, parts[1], json(d)]);
    return send(res, 200, { ok: true });
  }
  if (m === "PUT" && parts[0] === "sessions" && idOk(parts[1])) return putSession(uid, parts[1], body && body.data, res, body && body.clientNow);
  if (m === "PUT" && parts[0] === "profile") {
    const d = body && body.data; await q(`UPDATE users SET sum = $2, last_seen = $3 WHERE id = $1`, [uid, json(d && d.sum || null), Date.now()]);
    return send(res, 200, { ok: true });
  }
  if (m === "POST" && parts[0] === "quiz" && !parts[1]) return makeQuiz(uid, body || {}, res);
  if (m === "POST" && parts[0] === "quiz" && parts[1] === "local") {
    const a = body && body.answers;
    if (!Array.isArray(a) || a.length < 2 || a.length > 5 || !a.every(x => Number.isInteger(x) && x >= 0 && x < 6)) return err(res, 400, "bad", "Noto‘g‘ri test.");
    const id = "l" + crypto.randomBytes(9).toString("hex");
    await q(`INSERT INTO quizzes (id, user_id, answers, picks, created_at) VALUES ($1,$2,$3,$4,$5)`, [id, uid, json(a), json({}), Date.now()]);
    return send(res, 200, { quizId: id });
  }
  if (m === "POST" && parts[0] === "quiz" && idOk(parts[1]) && parts[2] === "answer") return answerQuiz(uid, parts[1], body || {}, res);
  // ustoz
  if (parts[0] === "students" || parts[0] === "homework") {
    if (!me.isTeacher) return err(res, 403, "teacher_only", "Faqat ustoz uchun.");
    if (m === "GET" && parts[0] === "students" && !parts[1]) {
      const rows = await q(`SELECT id, name, username, joined_at, last_seen, sum FROM users ORDER BY last_seen DESC`);
      return send(res, 200, rows.map(r => ({ id: String(r.id), name: r.name, username: r.username, joinedAt: Number(r.joined_at), lastSeen: Number(r.last_seen), sum: parse(r.sum) })));
    }
    if (m === "GET" && parts[0] === "students" && /^\d+$/.test(parts[1] || "") && parts[2] === "sessions") {
      const rows = await q(`SELECT id, data FROM sessions WHERE user_id = $1 ORDER BY start_ts DESC LIMIT 1000`, [parts[1]]);
      return send(res, 200, rows.map(r => ({ id: r.id, ...parse(r.data) })));
    }
    if (m === "PUT" && parts[0] === "homework" && idOk(parts[1])) {
      const d = body && body.data; if (!d || typeof d !== "object") return err(res, 400, "bad", "Ma’lumot yo‘q.");
      await q(`INSERT INTO homework (id, data, created_by) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [parts[1], json(d), uid]);
      return send(res, 200, { ok: true });
    }
    if (m === "DELETE" && parts[0] === "homework" && idOk(parts[1])) { await q(`DELETE FROM homework WHERE id = $1`, [parts[1]]); return send(res, 200, { ok: true }); }
  }
  err(res, 404, "not_found", "Topilmadi.");
}

/* ---------- Telegram bot (webhook) ---------- */
const hookPath = () => "/tg/" + crypto.createHash("sha256").update(TOKEN || "x").digest("hex").slice(0, 24);
// Eski sayt build’i tokenni shu yerga yuboradi. Faqat shu botning haqiqiy tokeni qabul qilinadi (getMe bilan tekshiriladi).
async function registerToken(body, res) {
  const t = body && typeof body.token === "string" ? body.token.trim() : "";
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(t)) return err(res, 400, "bad", "Token formati noto‘g‘ri.");
  if (BOT_ID && t.split(":")[0] !== String(BOT_ID)) return err(res, 403, "other_bot", "Bu boshqa botning tokeni.");
  let me;
  try { me = await (await fetch(`https://api.telegram.org/bot${t}/getMe`)).json(); } catch (e) { return err(res, 502, "tg", "Telegram’ga ulanib bo‘lmadi."); }
  if (!me || !me.ok) return err(res, 403, "invalid", "Token yaroqsiz.");
  await q(`INSERT INTO settings (key, value) VALUES ('bot_token', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [t]);
  const changed = t !== TOKEN; TOKEN = t; BOT_ID = String(me.result.id);
  if (changed) console.log("Bot tokeni ro‘yxatdan o‘tdi: @" + me.result.username);
  await setupBot();
  send(res, 200, { ok: true, bot: me.result.username });
}
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return r.json().catch(() => ({}));
}
async function setupBot() {
  if (!TOKEN || !PUBLIC_URL) { console.log("Token serverda yo‘q — bot menyusini eski sayt sozlaydi, kirish Ed25519 imzo bilan tekshiriladi."); return; }
  try {
    console.log("menu", JSON.stringify(await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Fikrlab", web_app: { url: PUBLIC_URL } } })));
    console.log("webhook", JSON.stringify(await tg("setWebhook", { url: PUBLIC_URL + hookPath(), allowed_updates: ["message"], drop_pending_updates: false })));
    await tg("setMyCommands", { commands: [{ command: "start", description: "Fikrlab’ni ochish" }, { command: "id", description: "Telegram ID’ni ko‘rish" }] });
    await tg("setMyDescription", { description: "Fikrlab — tez o‘qish mashq xonasi: PDF kitob o‘qish, diagnostika, Shulte, sakkad va boshqa mashqlar. Natijalar halol hisoblanadi." });
    await tg("setMyShortDescription", { short_description: "Tez o‘qish mashq xonasi 📖" });
  } catch (e) { console.error("bot setup", e.message); }
}
async function onUpdate(u) {
  const msg = u && u.message; if (!msg || !msg.chat) return;
  const text = (msg.text || "").trim();
  if (text.startsWith("/start") || text === "/app") {
    await tg("sendMessage", { chat_id: msg.chat.id, text: "Fikrlab mashq xonasiga xush kelibsiz! 📖\n\nKitob o‘qing, diagnostika va mashqlarni bajaring — hammasi avtomatik va halol hisoblanadi. Kunlik me’yor: 20 daqiqa faol o‘qish.", reply_markup: { inline_keyboard: [[{ text: "Fikrlab’ni ochish", web_app: { url: PUBLIC_URL } }]] } });
  } else if (text === "/id") {
    await tg("sendMessage", { chat_id: msg.chat.id, text: "Sizning Telegram ID: " + (msg.from && msg.from.id) });
  }
}

/* ---------- statik fayl ---------- */
let INDEX = null;
function indexHtml() {
  if (INDEX && process.env.NODE_ENV === "production") return INDEX;
  let h = fs.readFileSync(path.join(DIR, "web", "index.html"), "utf8");
  h = h.replace("<title>", '<script src="https://telegram.org/js/telegram-web-app.js"></script><title>');
  INDEX = h; return h;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method === "POST" && url.pathname === "/admin/bot-token") return await registerToken(await readBody(req, 1e4), res);
    if (req.method === "POST" && TOKEN && url.pathname === hookPath()) { const b = await readBody(req, 1e6); send(res, 200, { ok: true }); onUpdate(b).catch(e => console.error("update", e.message)); return; }
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(indexHtml());
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Topilmadi");
  } catch (e) {
    console.error(req.method, url.pathname, e);
    if (!res.headersSent) err(res, e.status || 500, e.message === "too_large" ? "too_large" : "server", "Server xatosi. Birozdan keyin urinib ko‘ring.");
  }
});

migrate().then(() => {
  server.listen(PORT, () => { console.log("Fikrlab server :" + PORT); setupBot(); loadBotId(); });
}).catch(e => { console.error("DB migratsiya xatosi", e); process.exit(1); });
