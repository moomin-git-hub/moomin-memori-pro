"use strict";
/**
 * ME'MORI (Esda qolsin) — Backend Server
 * Express + PostgreSQL (Neon) + JWT + Google OAuth + Web Push + Gemini AI + Daily Telegram Backup (JSON + Word + PDF)
 */
const express = require("express");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const webpush = require("web-push");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "memori-secret-change-in-prod";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "memori_uz_bot";
const MAX_FILE_MB = +(process.env.MAX_FILE_MB || 10);

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "0" ? false : { rejectUnauthorized: false } })
  : null;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@memori.uz",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const app = express();
app.use(compression());
app.use(express.json({ limit: "15mb" }));
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1048576 } });
const uid = () => crypto.randomBytes(8).toString("hex");
const todayIso = () => new Date().toISOString().slice(0, 10);

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      pass_hash TEXT,
      picture TEXT,
      ext_key TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS records (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      u BIGINT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_records_user_u ON records(user_id, u);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INT NOT NULL,
      body BYTEA NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sub JSONB NOT NULL,
      hour INT DEFAULT 7,
      tz TEXT DEFAULT 'Asia/Tashkent',
      last_sent TEXT
    );
    CREATE TABLE IF NOT EXISTS tg_links (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT UNIQUE,
      name TEXT,
      code TEXT UNIQUE,
      hour INT DEFAULT 7,
      last_backup TIMESTAMPTZ,
      last_daily TEXT
    );
  `);
}

function setAuthCookie(res, userId) {
  const tok = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: "90d" });
  res.cookie("memori_tok", tok, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 90 * 864e5 });
}

function requireAuth(req, res, next) {
  const tok = req.cookies && req.cookies.memori_tok;
  if (!tok) return res.status(401).json({ error: "Hisobga kiring." });
  try {
    req.uid = jwt.verify(tok, JWT_SECRET).uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Sessiya muddati tugagan." });
  }
}

app.get("/api/health", (req, res) => res.json({ ok: true, app: "esda-qolsin" }));
app.get("/api/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, maxFileMb: MAX_FILE_MB, ai: !!GEMINI_API_KEY }));

app.get("/api/me", requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Ma'lumotlar bazasi ulanmagan." });
  const { rows } = await pool.query("SELECT id, email, name, picture FROM users WHERE id = $1", [req.uid]);
  if (!rows[0]) return res.status(401).json({ error: "Foydalanuvchi topilmadi." });
  res.json(rows[0]);
});

app.post("/api/auth/register", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DB ulanmagan." });
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const name = String(req.body.name || "").trim() || email.split("@")[0];
  if (!email || password.length < 8) return res.status(400).json({ error: "Email va kamida 8 belgili parol kiriting." });
  const hash = await bcrypt.hash(password, 10);
  const id = uid();
  try {
    const { rows } = await pool.query(
      "INSERT INTO users (id, email, name, pass_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name, picture",
      [id, email, name, hash]
    );
    setAuthCookie(res, id);
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: "Bu email allaqachon ro'yxatdan o'tgan." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DB ulanmagan." });
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const u = rows[0];
  if (!u || !u.pass_hash || !(await bcrypt.compare(password, u.pass_hash))) {
    return res.status(401).json({ error: "Email yoki parol noto'g'ri." });
  }
  setAuthCookie(res, u.id);
  res.json({ id: u.id, email: u.email, name: u.name, picture: u.picture });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("memori_tok");
  res.json({ ok: true });
});

app.post("/api/sync", requireAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DB ulanmagan." });
  const since = +(req.body.since || 0);
  const incoming = Array.isArray(req.body.recs) ? req.body.recs : [];
  const now = Date.now();
  for (const r of incoming) {
    if (!r || typeof r.id !== "string") continue;
    const u = +(r.u || now);
    await pool.query(
      `INSERT INTO records (user_id, id, u, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, id) DO UPDATE SET u = EXCLUDED.u, data = EXCLUDED.data WHERE records.u < EXCLUDED.u`,
      [req.uid, r.id, u, r]
    );
  }
  const { rows } = await pool.query("SELECT data, u FROM records WHERE user_id = $1 AND u > $2", [req.uid, since]);
  const maxU = rows.reduce((m, r) => Math.max(m, +r.u), since);
  res.json({ recs: rows.map(r => r.data), since: maxU || now });
});

/* ── Gemini AI Endpoints (Book Summary Analysis, Flashcards & Glossary) ── */
async function askGeminiServer(prompt, imageBase64) {
  if (!GEMINI_API_KEY) throw new Error("Serverda GEMINI_API_KEY sozlanmagan.");
  const parts = [{ text: prompt }];
  if (imageBase64 && imageBase64.startsWith("data:")) {
    const [meta, b64] = imageBase64.split(",");
    const mimeType = (meta.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
    parts.push({ inlineData: { mimeType, data: b64 } });
  }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" }
    })
  });
  if (!r.ok) throw new Error("Gemini API javob bermadi.");
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return JSON.parse(txt.replace(/^```json\s*|```$/g, "").trim());
}

app.post("/api/ai/gemini", requireAuth, async (req, res) => {
  try {
    const result = await askGeminiServer(String(req.body.prompt || ""), req.body.image);
    res.json({ result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/ai/cards", requireAuth, async (req, res) => {
  try {
    const { text, image, title } = req.body;
    const prompt = `Sen "ME'MORI" o'rganish ilovasining AI yordamchisisan. Manba: "${title || ""}". Quyidagi ma'lumot asosida 4-6 ta eng muhim savol-javob kartochkasini o'zbek tilida JSON massiv shaklida qaytar: [{"q":"Savol","a":"Javob"}].\nMatn:\n${String(text || "").slice(0, 6000)}`;
    const cards = await askGeminiServer(prompt, image);
    res.json({ cards: Array.isArray(cards) ? cards : (cards.cards || []) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── Server-side Word (.doc), PDF (.pdf) & JSON Backup Builders for Telegram ── */
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildUserWordBuffer(recsMap, day) {
  const all = Object.values(recsMap).filter(r => r && !r.del);
  const books = all.filter(r => r.k === "b");
  const items = all.filter(r => r.k === "i");
  const rowsHtml = books.map(b => {
    const bitems = items.filter(i => i.b === b.id);
    return `<h2>${escHtml(b.title)}${b.author ? " — " + escHtml(b.author) : ""}</h2>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:10.5pt">
      <tr style="background:#161c48;color:#ffffff"><th>Turi</th><th>Bet / Qator</th><th>Savol / Atama</th><th>Xulosa / Javob</th><th>Keyingi takror</th></tr>
      ${bitems.map(i => `<tr>
        <td><b>${escHtml(i.t)}</b></td>
        <td>${i.f ? `${i.f}${i.e && i.e !== i.f ? "-" + i.e : ""}-bet` : ""} ${i.lf ? `${i.lf}${i.lt && i.lt !== i.lf ? "-" + i.lt : ""}-qator` : ""}</td>
        <td>${escHtml(i.q || i.r || "—")}</td>
        <td>${escHtml(i.a || "")}</td>
        <td>${escHtml(i.d || "")} (EF ${(i.ef || 2.5).toFixed(2)})</td>
      </tr>`).join("")}
    </table>`;
  }).join("<hr>");
  const html = `\ufeff<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
  <head><meta charset="utf-8"><title>ME'MORI ${day}</title></head>
  <body style="font-family:Calibri,Arial,sans-serif">
    <h1>ME'MORI — Kunlik Zaxira (${day})</h1>
    <p>Manbalar: ${books.length} ta | Yozuvlar: ${items.length} ta</p>
    ${rowsHtml}
  </body></html>`;
  return Buffer.from(html, "utf8");
}

function buildUserPdfBuffer(recsMap, day) {
  const ascii = s => String(s || "").replace(/[ʻʼ‘’`´]/g, "'").replace(/[«»""]/g, '"').replace(/[—–]/g, "-").replace(/[^\x20-\x7E]/g, "?");
  const pdfEsc = s => ascii(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const all = Object.values(recsMap).filter(r => r && !r.del);
  const books = all.filter(r => r.k === "b");
  const items = all.filter(r => r.k === "i");
  const lines = [
    `ME'MORI - KUNLIK ZAXIRA HISOBOTI (${day})`,
    `Manbalar: ${books.length} | Yozuvlar: ${items.length}`,
    "======================================================================",
    ""
  ];
  for (const b of books) {
    lines.push(`MANBA: ${b.title}${b.author ? " (" + b.author + ")" : ""}`);
    for (const i of items.filter(x => x.b === b.id)) {
      const loc = [i.f ? `${i.f}-bet` : "", i.lf ? `${i.lf}-qator` : ""].filter(Boolean).join(", ");
      lines.push(`  * [${i.t}] ${loc ? "(" + loc + ") " : ""}${i.q || i.r || ""} -> Takror: ${i.d}`);
      const body = String(i.a || "").replace(/\s+/g, " ");
      for (let k = 0; k < body.length; k += 80) lines.push("    " + body.slice(k, k + 80));
    }
    lines.push("");
  }
  const perPage = 46, pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push(["ME'MORI"]);
  const objs = [];
  const addObj = body => { objs.push(body); return objs.length; };
  const fontId = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];
  for (const plines of pages) {
    const stream = ["BT", "/F1 10 Tf", "40 790 Td", "15 TL", ...plines.map(l => `(${pdfEsc(l)}) Tj T*`), "ET"].join("\n");
    const cId = addObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(addObj(`<< /Type /Page /Parent PAGES_ID 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${cId} 0 R >>`));
  }
  const pagesId = addObj(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const catId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((b, idx) => {
    offs.push(out.length);
    out += `${idx + 1} 0 obj\n${b.replace(/PAGES_ID/g, String(pagesId))}\nendobj\n`;
  });
  const xrefPos = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += String(o).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, "utf8");
}

async function sendTgDocument(chatId, buffer, filename, caption) {
  if (!TG_TOKEN || !chatId) return;
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  fd.append("document", new Blob([buffer]), filename);
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: "POST", body: fd });
}

async function sendUserAllBackupsToTelegram(userId, chatId) {
  const { rows } = await pool.query("SELECT id, data FROM records WHERE user_id = $1", [userId]);
  const recsMap = {};
  for (const r of rows) if (r.data && !r.data.del) recsMap[r.id] = r.data;
  const day = todayIso();
  const jsonBuf = Buffer.from(JSON.stringify({ app: "esda-qolsin", v: 2, saved: new Date().toISOString(), recs: recsMap }, null, 1), "utf8");
  const wordBuf = buildUserWordBuffer(recsMap, day);
  const pdfBuf = buildUserPdfBuffer(recsMap, day);
  await sendTgDocument(chatId, jsonBuf, `memori-${day}.json`, `📦 ME'MORI kunlik JSON zaxira (${day})`);
  await sendTgDocument(chatId, wordBuf, `memori-${day}.doc`, `📄 ME'MORI kunlik Word konspekt (${day})`);
  await sendTgDocument(chatId, pdfBuf, `memori-${day}.pdf`, `📕 ME'MORI kunlik PDF hisobot (${day})`);
  await pool.query("UPDATE tg_links SET last_backup = NOW(), last_daily = $2 WHERE user_id = $1", [userId, day]);
  return Object.values(recsMap).filter(x => x.k === "i").length;
}

app.get("/api/tg", requireAuth, async (req, res) => {
  if (!pool) return res.json({ configured: !!TG_TOKEN, linked: false });
  const { rows } = await pool.query("SELECT * FROM tg_links WHERE user_id = $1", [req.uid]);
  const t = rows[0];
  res.json({ configured: !!TG_TOKEN, linked: !!(t && t.chat_id), name: t?.name || "", hour: t?.hour ?? 7, lastBackup: t?.last_backup || null });
});

app.post("/api/tg/backup", requireAuth, async (req, res) => {
  if (!pool || !TG_TOKEN) return res.status(400).json({ error: "Telegram bot ulanmagan." });
  const { rows } = await pool.query("SELECT chat_id FROM tg_links WHERE user_id = $1", [req.uid]);
  if (!rows[0] || !rows[0].chat_id) return res.status(400).json({ error: "Avval Telegram hisobingizni ulang." });
  const notes = await sendUserAllBackupsToTelegram(req.uid, rows[0].chat_id);
  res.json({ ok: true, notes });
});

// Daily automated cron job: sends JSON + Word + PDF backups & review reminders to all linked Telegram users every day
setInterval(async () => {
  if (!pool || !TG_TOKEN) return;
  try {
    const day = todayIso(), hour = (new Date().getUTCHours() + 5) % 24;
    const { rows } = await pool.query("SELECT user_id, chat_id, hour, last_daily FROM tg_links WHERE chat_id IS NOT NULL");
    for (const r of rows) {
      if ((r.hour ?? 7) === hour && r.last_daily !== day) {
        await sendUserAllBackupsToTelegram(r.user_id, r.chat_id).catch(() => {});
      }
    }
  } catch (e) {}
}, 15 * 60 * 1000);

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

initDb().then(() => {
  app.listen(PORT, () => console.log(`ME'MORI server listening on port ${PORT}`));
}).catch(err => {
  console.error("DB init error:", err);
  app.listen(PORT, () => console.log(`ME'MORI server listening (no DB) on port ${PORT}`));
});
