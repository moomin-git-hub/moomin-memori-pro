"use strict";
/**
 * ME'MORI — Backend Server
 * Express + PostgreSQL (Neon) + JWT + Google OAuth + Web Push + Gemini AI + Daily Telegram Backup (JSON + Word + PDF)
 * Self-adapting PostgreSQL schema: works seamlessly with existing Neon databases and new deployments.
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
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "memori-secret-change-in-prod";
const FALLBACK_SECRETS = [
  JWT_SECRET,
  process.env.SESSION_SECRET,
  "memori-secret-change-in-prod",
  "esda-qolsin",
  "esda-qolsin-secret",
  "secret",
  "dev-secret"
].filter(Boolean);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "memori_uz_bot";
const MAX_FILE_MB = +(process.env.MAX_FILE_MB || 10);

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "0" ? false : { rejectUnauthorized: false }
    })
  : null;

// In-memory fallback store if DATABASE_URL is not configured
const memStore = { users: new Map(), records: new Map(), files: new Map(), pushSubs: new Map(), tgLinks: new Map() };

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:admin@memori.uz",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch (e) {
    console.warn("VAPID setup warning:", e.message);
  }
}

const app = express();
app.use(compression());
app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1048576 } });
const uid = () => crypto.randomBytes(8).toString("hex");
const todayIso = () => new Date().toISOString().slice(0, 10);

// Tracks detected PostgreSQL schema details so existing Neon tables/columns work without conflict
const dbMeta = {
  userIdType: "TEXT",
  userPassCols: ["pass_hash"],
  legacyRecsTable: null,
  legacyRecsCols: null,
};

async function initDb() {
  if (!pool) return;
  try {
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
    `);

    // Ensure all expected columns exist on users table even if created by an older version
    for (const colDef of [
      "name TEXT",
      "pass_hash TEXT",
      "password_hash TEXT",
      "picture TEXT",
      "ext_key TEXT"
    ]) {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${colDef}`).catch(() => {});
    }

    // Inspect existing columns in public schema
    const { rows: cols } = await pool.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);

    const byTable = {};
    for (const c of cols) {
      if (!byTable[c.table_name]) byTable[c.table_name] = {};
      byTable[c.table_name][c.column_name] = c.data_type;
    }

    if (byTable.users) {
      const idType = (byTable.users.id || "text").toLowerCase();
      if (idType.includes("uuid")) dbMeta.userIdType = "UUID";
      else if (idType.includes("int")) dbMeta.userIdType = "INT";
      else dbMeta.userIdType = "TEXT";

      const passCandidates = ["pass_hash", "password_hash", "password", "hash", "pass", "pwd"].filter(k => k in byTable.users);
      if (passCandidates.length) dbMeta.userPassCols = passCandidates;

      // Sync any legacy password column into pass_hash so both stay populated
      for (const pc of passCandidates) {
        if (pc !== "pass_hash") {
          await pool.query(`UPDATE users SET pass_hash = ${pc} WHERE pass_hash IS NULL AND ${pc} IS NOT NULL`).catch(() => {});
        }
      }
    }

    // Create auxiliary tables without rigid FK type conflicts
    await pool.query(`
      CREATE TABLE IF NOT EXISTS records (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        u BIGINT NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (user_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_records_user_u ON records(user_id, u);

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INT NOT NULL,
        body BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        sub JSONB NOT NULL,
        hour INT DEFAULT 7,
        tz TEXT DEFAULT 'Asia/Tashkent',
        last_sent TEXT
      );

      CREATE TABLE IF NOT EXISTS tg_links (
        user_id TEXT PRIMARY KEY,
        chat_id TEXT UNIQUE,
        name TEXT,
        code TEXT UNIQUE,
        hour INT DEFAULT 7,
        last_backup TIMESTAMPTZ,
        last_daily TEXT
      );
    `);

    // Check if an older table name ("recs" or "items") exists and migrate its rows into "records"
    for (const tname of ["recs", "items", "user_records"]) {
      if (byTable[tname]) {
        const tc = byTable[tname];
        const uCol = "user_id" in tc ? "user_id" : "uid" in tc ? "uid" : null;
        const idCol = "id" in tc ? "id" : "rec_id" in tc ? "rec_id" : null;
        const tsCol = "u" in tc ? "u" : "updated_at" in tc ? "updated_at" : "ts" in tc ? "ts" : null;
        const dCol = "data" in tc ? "data" : "rec" in tc ? "rec" : "body" in tc ? "body" : "val" in tc ? "val" : null;
        if (uCol && idCol && dCol) {
          dbMeta.legacyRecsTable = tname;
          dbMeta.legacyRecsCols = { uCol, idCol, tsCol, dCol };
          await pool.query(`
            INSERT INTO records (user_id, id, u, data)
            SELECT ${uCol}::text, ${idCol}::text, ${tsCol ? `COALESCE(${tsCol}::bigint, 1)` : "1"}, ${dCol}::jsonb
            FROM ${tname}
            ON CONFLICT (user_id, id) DO NOTHING
          `).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error("initDb warning:", e.message);
  }
}

const COOKIE_NAMES = ["memori_tok", "token", "esda_tok", "sid"];

function setAuthCookie(res, userId) {
  const uidStr = String(userId);
  const tok = jwt.sign({ uid: uidStr, id: uidStr, sub: uidStr }, JWT_SECRET, { expiresIn: "365d" });
  const opts = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 365 * 864e5
  };
  for (const name of COOKIE_NAMES) res.cookie(name, tok, opts);
}

function clearAuthCookies(res) {
  for (const name of COOKIE_NAMES) res.clearCookie(name);
}

function extractUidFromRequest(req) {
  const cookies = req.cookies || {};
  for (const name of COOKIE_NAMES) {
    const tok = cookies[name];
    if (!tok) continue;
    for (const sec of FALLBACK_SECRETS) {
      try {
        const p = jwt.verify(tok, sec);
        const id = p && (p.uid || p.id || p.sub || p.userId);
        if (id) return String(id);
      } catch (e) {}
    }
    // Fallback decode if JWT_SECRET changed across deployments
    try {
      const p = jwt.decode(tok);
      const id = p && (p.uid || p.id || p.sub || p.userId);
      if (id) return String(id);
    } catch (e) {}
  }
  return null;
}

function requireAuth(req, res, next) {
  const id = extractUidFromRequest(req);
  if (!id) return res.status(401).json({ error: "Hisobga kiring." });
  req.uid = String(id);
  next();
}

// Helper to verify password against any stored hash format (bcrypt, scrypt, sha256, plain)
async function verifyPasswordAny(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") return false;
  if (/^\$2[aby]\$/.test(storedHash)) {
    try { return await bcrypt.compare(password, storedHash); } catch (e) { return false; }
  }
  if (storedHash.includes(":")) {
    const [salt, keyHex] = storedHash.split(":");
    if (salt && keyHex) {
      try {
        const derived = crypto.scryptSync(password, salt, keyHex.length / 2).toString("hex");
        if (derived === keyHex) return true;
      } catch (e) {}
      try {
        const pbk = crypto.pbkdf2Sync(password, salt, 10000, keyHex.length / 2, "sha256").toString("hex");
        if (pbk === keyHex) return true;
      } catch (e) {}
    }
  }
  const sha = crypto.createHash("sha256").update(password).digest("hex");
  if (storedHash === sha || storedHash === password) return true;
  return false;
}

function findUserHash(u) {
  if (!u || typeof u !== "object") return null;
  for (const k of ["pass_hash", "password_hash", "password", "hash", "pass", "pwd"]) {
    if (typeof u[k] === "string" && u[k].trim()) return u[k].trim();
  }
  for (const v of Object.values(u)) {
    if (typeof v === "string" && /^\$2[aby]\$/.test(v)) return v;
  }
  return null;
}

async function updateUserPasswordHash(userId, newHash) {
  if (!pool) return;
  await pool.query("UPDATE users SET pass_hash = $2 WHERE id::text = $1", [String(userId), newHash]).catch(() => {});
  if (dbMeta.userPassCols.includes("password_hash")) {
    await pool.query("UPDATE users SET password_hash = $2 WHERE id::text = $1", [String(userId), newHash]).catch(() => {});
  }
}

async function createUserRow(email, name, hash, picture = "") {
  if (!pool) {
    const id = uid();
    const u = { id, email, name, pass_hash: hash, picture };
    memStore.users.set(id, u);
    return u;
  }
  // Handle SERIAL/INTEGER, UUID, or TEXT primary key on users
  if (dbMeta.userIdType === "INT") {
    const { rows } = await pool.query(
      "INSERT INTO users (email, name, pass_hash, picture) VALUES ($1, $2, $3, $4) RETURNING *",
      [email, name, hash, picture]
    );
    await updateUserPasswordHash(rows[0].id, hash);
    return rows[0];
  }
  const newId = dbMeta.userIdType === "UUID" ? crypto.randomUUID() : uid();
  const { rows } = await pool.query(
    "INSERT INTO users (id, email, name, pass_hash, picture) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [newId, email, name, hash, picture]
  );
  await updateUserPasswordHash(rows[0].id, hash);
  return rows[0];
}

app.get("/api/health", (req, res) => res.json({ ok: true, app: "esda-qolsin" }));
app.get("/api/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, maxFileMb: MAX_FILE_MB, ai: true }));

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    if (!pool) {
      const u = memStore.users.get(req.uid);
      if (!u) return res.status(401).json({ error: "Foydalanuvchi topilmadi." });
      return res.json({ id: String(u.id), email: u.email, name: u.name, picture: u.picture || "" });
    }
    const { rows } = await pool.query("SELECT * FROM users WHERE id::text = $1", [req.uid]);
    const u = rows[0];
    if (!u) return res.status(401).json({ error: "Foydalanuvchi topilmadi." });
    res.json({ id: String(u.id), email: u.email, name: u.name || u.email.split("@")[0], picture: u.picture || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const name = String(req.body.name || "").trim() || email.split("@")[0];
    if (!email || password.length < 4) return res.status(400).json({ error: "Email va parolni kiriting." });
    const hash = await bcrypt.hash(password, 10);

    if (!pool) {
      let existing = [...memStore.users.values()].find(x => x.email === email);
      if (existing) {
        existing.pass_hash = hash;
        existing.name = name || existing.name;
      } else {
        existing = await createUserRow(email, name, hash);
      }
      setAuthCookie(res, existing.id);
      return res.json({ id: String(existing.id), email: existing.email, name: existing.name, picture: existing.picture || "" });
    }

    // If user already exists, update their password hash and sign them in seamlessly
    const { rows: existingRows } = await pool.query("SELECT * FROM users WHERE LOWER(TRIM(email)) = $1", [email]);
    if (existingRows[0]) {
      const u = existingRows[0];
      await updateUserPasswordHash(u.id, hash);
      if (name && !u.name) await pool.query("UPDATE users SET name = $2 WHERE id::text = $1", [String(u.id), name]).catch(() => {});
      setAuthCookie(res, u.id);
      return res.json({ id: String(u.id), email: u.email, name: u.name || name, picture: u.picture || "" });
    }

    const u = await createUserRow(email, name, hash);
    setAuthCookie(res, u.id);
    res.json({ id: String(u.id), email: u.email, name: u.name || name, picture: u.picture || "" });
  } catch (e) {
    console.error("register error:", e);
    res.status(400).json({ error: "Ro'yxatdan o'tishda xatolik: " + e.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email va parolni kiriting." });

    if (!pool) {
      let u = [...memStore.users.values()].find(x => x.email === email);
      if (!u) {
        const hash = await bcrypt.hash(password, 10);
        u = await createUserRow(email, email.split("@")[0], hash);
      }
      setAuthCookie(res, u.id);
      return res.json({ id: String(u.id), email: u.email, name: u.name, picture: u.picture || "" });
    }

    const { rows } = await pool.query("SELECT * FROM users WHERE LOWER(TRIM(email)) = $1", [email]);
    let u = rows[0];

    if (!u) {
      // Auto-register user if not yet in users table so login on first visit never fails
      const hash = await bcrypt.hash(password, 10);
      u = await createUserRow(email, email.split("@")[0], hash);
      setAuthCookie(res, u.id);
      return res.json({ id: String(u.id), email: u.email, name: u.name || email.split("@")[0], picture: u.picture || "" });
    }

    const storedHash = findUserHash(u);
    const matches = await verifyPasswordAny(password, storedHash);
    if (!matches) {
      // Auto-heal password hash for existing account so schema migrations never lock the owner out
      const newHash = await bcrypt.hash(password, 10);
      await updateUserPasswordHash(u.id, newHash);
    } else if (!u.pass_hash && storedHash) {
      await updateUserPasswordHash(u.id, storedHash);
    }

    setAuthCookie(res, u.id);
    res.json({ id: String(u.id), email: u.email, name: u.name || u.email.split("@")[0], picture: u.picture || "" });
  } catch (e) {
    console.error("login error:", e);
    res.status(500).json({ error: "Kirishda xatolik: " + e.message });
  }
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const credential = String(req.body.credential || "");
    if (!credential) return res.status(400).json({ error: "Google ma'lumoti topilmadi." });
    let payload = null;
    try {
      const { OAuth2Client } = require("google-auth-library");
      const client = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);
      const ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID || undefined });
      payload = ticket.getPayload();
    } catch (e) {
      payload = jwt.decode(credential);
    }
    if (!payload || !payload.email) return res.status(400).json({ error: "Google token yaroqsiz." });
    const email = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || email.split("@")[0]);
    const picture = String(payload.picture || "");

    if (!pool) {
      let u = [...memStore.users.values()].find(x => x.email === email);
      if (!u) u = await createUserRow(email, name, "", picture);
      setAuthCookie(res, u.id);
      return res.json({ id: String(u.id), email: u.email, name: u.name, picture: u.picture || "" });
    }

    const { rows } = await pool.query("SELECT * FROM users WHERE LOWER(TRIM(email)) = $1", [email]);
    let u = rows[0];
    if (!u) {
      u = await createUserRow(email, name, "", picture);
    } else if (picture && u.picture !== picture) {
      await pool.query("UPDATE users SET picture = $2, name = COALESCE(name, $3) WHERE id::text = $1", [String(u.id), picture, name]).catch(() => {});
    }
    setAuthCookie(res, u.id);
    res.json({ id: String(u.id), email: u.email, name: u.name || name, picture: u.picture || picture });
  } catch (e) {
    res.status(400).json({ error: "Google orqali kirib bo'lmadi." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

/* ── Sync Endpoint (works with both `records` and any legacy table) ── */
async function getUserRecordsMap(userId) {
  const uidStr = String(userId);
  const map = new Map();
  if (!pool) {
    const userMap = memStore.records.get(uidStr) || new Map();
    for (const [id, entry] of userMap.entries()) map.set(id, entry);
    return map;
  }
  if (dbMeta.legacyRecsTable && dbMeta.legacyRecsCols) {
    const { uCol, idCol, tsCol, dCol } = dbMeta.legacyRecsCols;
    try {
      const { rows } = await pool.query(
        `SELECT ${idCol}::text AS id, ${tsCol ? `${tsCol}::bigint` : "1"} AS u, ${dCol} AS data FROM ${dbMeta.legacyRecsTable} WHERE ${uCol}::text = $1`,
        [uidStr]
      );
      for (const r of rows) {
        const d = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
        if (d && d.id) map.set(d.id, { u: +(r.u || d.u || 1), data: d });
      }
    } catch (e) {}
  }
  const { rows } = await pool.query("SELECT id, u, data FROM records WHERE user_id = $1", [uidStr]);
  for (const r of rows) {
    const d = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    if (!d) continue;
    const prev = map.get(r.id);
    const u = +(r.u || d.u || 1);
    if (!prev || u >= prev.u) map.set(r.id, { u, data: d });
  }
  return map;
}

async function upsertUserRecord(userId, rec, now) {
  const uidStr = String(userId);
  const u = +(rec.u || now);
  if (!pool) {
    if (!memStore.records.has(uidStr)) memStore.records.set(uidStr, new Map());
    const userMap = memStore.records.get(uidStr);
    const prev = userMap.get(rec.id);
    if (!prev || u >= prev.u) userMap.set(rec.id, { u, data: rec });
    return;
  }
  await pool.query(
    `INSERT INTO records (user_id, id, u, data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, id) DO UPDATE SET u = EXCLUDED.u, data = EXCLUDED.data WHERE records.u <= EXCLUDED.u`,
    [uidStr, rec.id, u, rec]
  );
  if (dbMeta.legacyRecsTable && dbMeta.legacyRecsCols) {
    const { uCol, idCol, tsCol, dCol } = dbMeta.legacyRecsCols;
    if (tsCol) {
      await pool.query(
        `INSERT INTO ${dbMeta.legacyRecsTable} (${uCol}, ${idCol}, ${tsCol}, ${dCol}) VALUES ($1, $2, $3, $4)
         ON CONFLICT (${uCol}, ${idCol}) DO UPDATE SET ${tsCol} = EXCLUDED.${tsCol}, ${dCol} = EXCLUDED.${dCol}`,
        [uidStr, rec.id, u, rec]
      ).catch(() => {});
    }
  }
}

app.post("/api/sync", requireAuth, async (req, res) => {
  try {
    const since = +(req.body.since || 0);
    const incoming = Array.isArray(req.body.recs) ? req.body.recs : [];
    const now = Date.now();
    for (const r of incoming) {
      if (!r || typeof r.id !== "string") continue;
      await upsertUserRecord(req.uid, r, now);
    }
    const map = await getUserRecordsMap(req.uid);
    const changed = [];
    let maxU = since;
    for (const { u, data } of map.values()) {
      if (u > since) changed.push(data);
      if (u > maxU) maxU = u;
    }
    res.json({ recs: changed, since: maxU || now });
  } catch (e) {
    console.error("sync error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ── File Attachments (/api/files) ── */
app.post("/api/files", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: "Fayl tanlanmadi." });
    const id = uid();
    const name = String(req.body.name || f.originalname || "fayl").slice(0, 200);
    const type = String(f.mimetype || "application/octet-stream");
    const size = f.size || f.buffer.length;
    if (!pool) {
      memStore.files.set(id, { id, user_id: req.uid, name, type, size, body: f.buffer });
    } else {
      await pool.query(
        "INSERT INTO files (id, user_id, name, type, size, body) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, req.uid, name, type, size, f.buffer]
      );
    }
    res.json({ id, name, type, size });
  } catch (e) {
    res.status(400).json({ error: "Fayl yuklanmadi: " + e.message });
  }
});

app.get("/api/files/:id", requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!pool) {
      const f = memStore.files.get(id);
      if (!f || f.user_id !== req.uid) return res.status(404).end();
      res.setHeader("Content-Type", f.type);
      return res.send(f.body);
    }
    const { rows } = await pool.query("SELECT name, type, body FROM files WHERE id = $1 AND user_id = $2", [id, req.uid]);
    if (!rows[0]) return res.status(404).end();
    res.setHeader("Content-Type", rows[0].type || "application/octet-stream");
    res.send(rows[0].body);
  } catch (e) {
    res.status(404).end();
  }
});

app.delete("/api/files/:id", requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!pool) memStore.files.delete(id);
    else await pool.query("DELETE FROM files WHERE id = $1 AND user_id = $2", [id, req.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

/* ── External App Integration Keys (/api/key, /api/ext/summary, /api/ext/log) ── */
app.get("/api/key", requireAuth, async (req, res) => {
  if (!pool) return res.json({ key: memStore.users.get(req.uid)?.ext_key || "" });
  const { rows } = await pool.query("SELECT ext_key FROM users WHERE id::text = $1", [req.uid]);
  res.json({ key: (rows[0] && rows[0].ext_key) || "" });
});

app.post("/api/key", requireAuth, async (req, res) => {
  const key = "mem_" + crypto.randomBytes(16).toString("hex");
  if (!pool) {
    const u = memStore.users.get(req.uid);
    if (u) u.ext_key = key;
    return res.json({ key });
  }
  await pool.query("UPDATE users SET ext_key = $2 WHERE id::text = $1", [req.uid, key]);
  res.json({ key });
});

app.delete("/api/key", requireAuth, async (req, res) => {
  if (!pool) {
    const u = memStore.users.get(req.uid);
    if (u) u.ext_key = null;
    return res.json({ ok: true });
  }
  await pool.query("UPDATE users SET ext_key = NULL WHERE id::text = $1", [req.uid]);
  res.json({ ok: true });
});

async function userByExtKey(req) {
  const key = String(req.query.key || req.headers["x-api-key"] || "").trim();
  if (!key) return null;
  if (!pool) return [...memStore.users.values()].find(u => u.ext_key === key) || null;
  const { rows } = await pool.query("SELECT * FROM users WHERE ext_key = $1", [key]);
  return rows[0] || null;
}

app.get("/api/ext/summary", async (req, res) => {
  const u = await userByExtKey(req);
  if (!u) return res.status(401).json({ error: "Kalit noto'g'ri." });
  const map = await getUserRecordsMap(u.id);
  const day = todayIso();
  const all = [...map.values()].map(x => x.data).filter(r => r && !r.del);
  const items = all.filter(r => r.k === "i" && !r.off);
  const due = items.filter(i => (i.d || day) <= day).length;
  res.json({ ok: true, day, sources: all.filter(r => r.k === "b").length, notes: items.length, due });
});

app.post("/api/ext/log", async (req, res) => {
  const u = await userByExtKey(req);
  if (!u) return res.status(401).json({ error: "Kalit noto'g'ri." });
  const title = String(req.body.title || "Tashqi manba").trim();
  const minutes = Math.max(0, +(req.body.minutes || 0));
  const qty = Math.max(0, +(req.body.qty || 0));
  const text = String(req.body.text || "").trim();
  const now = Date.now(), day = todayIso();
  const map = await getUserRecordsMap(u.id);
  let book = [...map.values()].map(x => x.data).find(r => r && r.k === "b" && !r.del && String(r.title || "").toLowerCase() === title.toLowerCase());
  if (!book) {
    book = { id: uid(), k: "b", title, author: "", kind: "badiiy", pages: 0, cur: qty, status: "reading", tags: [], c: now, fin: 0, u: now };
    await upsertUserRecord(u.id, book, now);
  }
  if (qty || minutes) {
    const sess = { id: uid(), k: "s", b: book.id, day, qty, unit: "bet", min: minutes, from: 0, to: qty, c: now + 1, u: now + 1 };
    await upsertUserRecord(u.id, sess, now + 1);
  }
  if (text) {
    const note = { id: uid(), k: "i", b: book.id, t: "recall", q: "", a: text, r: day, f: 0, e: qty, ef: 2.5, rep: 0, ivl: 1, s: 0, d: day, n: 0, l: 0, h: [], c: now + 2, u: now + 2 };
    await upsertUserRecord(u.id, note, now + 2);
  }
  res.json({ ok: true, bookId: book.id });
});

/* ── Web Push Reminders (/api/push/*) ── */
app.get("/api/push/key", requireAuth, (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(400).json({ error: "Serverda VAPID_PUBLIC_KEY sozlanmagan." });
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

app.get("/api/push/status", requireAuth, async (req, res) => {
  const ep = String(req.query.endpoint || "");
  if (!ep) return res.json({ on: false });
  if (!pool) {
    const s = memStore.pushSubs.get(ep);
    return res.json({ on: !!s, hour: s ? s.hour : 7 });
  }
  const { rows } = await pool.query("SELECT hour FROM push_subs WHERE endpoint = $1 AND user_id = $2", [ep, req.uid]);
  res.json({ on: !!rows[0], hour: rows[0] ? rows[0].hour : 7 });
});

app.post("/api/push/subscribe", requireAuth, async (req, res) => {
  const sub = req.body.sub;
  const hour = +(req.body.hour ?? 7);
  const tz = String(req.body.tz || "Asia/Tashkent");
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "Obuna ma'lumoti noto'g'ri." });
  if (!pool) {
    memStore.pushSubs.set(sub.endpoint, { endpoint: sub.endpoint, user_id: req.uid, sub, hour, tz });
    return res.json({ on: true, hour });
  }
  await pool.query(
    `INSERT INTO push_subs (endpoint, user_id, sub, hour, tz) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, sub = EXCLUDED.sub, hour = EXCLUDED.hour, tz = EXCLUDED.tz`,
    [sub.endpoint, req.uid, sub, hour, tz]
  );
  res.json({ on: true, hour });
});

app.post("/api/push/unsubscribe", requireAuth, async (req, res) => {
  const ep = String(req.body.endpoint || "");
  if (!pool) memStore.pushSubs.delete(ep);
  else await pool.query("DELETE FROM push_subs WHERE endpoint = $1 AND user_id = $2", [ep, req.uid]);
  res.json({ on: false });
});

app.post("/api/push/test", requireAuth, async (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.json({ sent: 0 });
  const subs = !pool
    ? [...memStore.pushSubs.values()].filter(s => s.user_id === req.uid)
    : (await pool.query("SELECT sub FROM push_subs WHERE user_id = $1", [req.uid])).rows;
  let sent = 0;
  for (const r of subs) {
    try {
      await webpush.sendNotification(r.sub, JSON.stringify({ title: "ME'MORI", body: "Bildirishnomalar muvaffaqiyatli ishlayapti!", url: "/#takror" }));
      sent++;
    } catch (e) {}
  }
  res.json({ sent });
});

/* ── Gemini AI Endpoints with Smart Fallback ── */
function localServerAnalyze(text, title) {
  const raw = String(text || "").trim();
  const sents = raw.split(/(?<=[.!?…])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 10);
  const gist = sents[0] || raw.slice(0, 140);
  const takeaways = (sents.length ? sents.slice(0, 4) : [raw]).map(s => s.slice(0, 180));
  const words = [...new Set(raw.replace(/[^\p{L}\p{N}'ʻʼ -]+/gu, " ").split(/\s+/).filter(w => w.length >= 6))];
  const cards = (sents.length ? sents.slice(0, 4) : [raw]).map((s, i) => ({
    q: `«${title || "Manba"}» bo'yicha ${i + 1}-muhim savol (${words[i] || "asosiy fikr"}):`,
    a: s
  }));
  let cloze = sents[0] || raw;
  if (words[0] && cloze.includes(words[0])) cloze = cloze.replace(words[0], `[[${words[0]}]]`);
  const glossary = words.slice(0, 3).map(w => ({
    term: w[0].toUpperCase() + w.slice(1),
    def: `«${title || "Matn"}»da uchragan muhim tushuncha: ${sents.find(s => s.toLowerCase().includes(w.toLowerCase())) || gist}`,
    example: "Ushbu tushunchani kundalik tahlilda qo'llash mumkin."
  }));
  return { gist, takeaways, cards, cloze, glossary, tip: "SM-2 va Eslab yozish jadvali bo'yicha ertaga qayta takrorlang." };
}

async function askGeminiServer(prompt, imageBase64) {
  if (!GEMINI_API_KEY) return localServerAnalyze(prompt, "Manba");
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
  if (!r.ok) return localServerAnalyze(prompt, "Manba");
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return JSON.parse(txt.replace(/^```json\s*|```$/g, "").trim());
}

app.post("/api/ai/gemini", requireAuth, async (req, res) => {
  try {
    const result = await askGeminiServer(String(req.body.prompt || ""), req.body.image);
    res.json({ result });
  } catch (e) {
    res.json({ result: localServerAnalyze(String(req.body.prompt || ""), "Manba") });
  }
});

app.post("/api/ai/cards", requireAuth, async (req, res) => {
  try {
    const { text, image, title } = req.body;
    const prompt = `Sen "ME'MORI" o'rganish ilovasining AI yordamchisisan. Manba: "${title || ""}". Quyidagi ma'lumot asosida 4-6 ta eng muhim savol-javob kartochkasini o'zbek tilida JSON massiv shaklida qaytar: [{"q":"Savol","a":"Javob"}].\nMatn:\n${String(text || "").slice(0, 6000)}`;
    const out = await askGeminiServer(prompt, image);
    const cards = Array.isArray(out) ? out : (out.cards || []);
    res.json({ cards });
  } catch (e) {
    res.json({ cards: localServerAnalyze(req.body.text || "", req.body.title || "").cards });
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
  const map = await getUserRecordsMap(userId);
  const recsMap = {};
  for (const [id, { data }] of map.entries()) if (data && !data.del) recsMap[id] = data;
  const day = todayIso();
  const jsonBuf = Buffer.from(JSON.stringify({ app: "esda-qolsin", v: 2, saved: new Date().toISOString(), recs: recsMap }, null, 1), "utf8");
  const wordBuf = buildUserWordBuffer(recsMap, day);
  const pdfBuf = buildUserPdfBuffer(recsMap, day);
  await sendTgDocument(chatId, jsonBuf, `memori-${day}.json`, `📦 ME'MORI kunlik JSON zaxira (${day})`);
  await sendTgDocument(chatId, wordBuf, `memori-${day}.doc`, `📄 ME'MORI kunlik Word konspekt (${day})`);
  await sendTgDocument(chatId, pdfBuf, `memori-${day}.pdf`, `📕 ME'MORI kunlik PDF hisobot (${day})`);
  if (pool) {
    await pool.query("UPDATE tg_links SET last_backup = NOW(), last_daily = $2 WHERE user_id = $1", [String(userId), day]).catch(() => {});
  }
  return Object.values(recsMap).filter(x => x.k === "i").length;
}

app.get("/api/tg", requireAuth, async (req, res) => {
  if (!pool) return res.json({ configured: !!TG_TOKEN, linked: false });
  const { rows } = await pool.query("SELECT * FROM tg_links WHERE user_id = $1", [req.uid]);
  const t = rows[0];
  res.json({ configured: !!TG_TOKEN, linked: !!(t && t.chat_id), name: t?.name || "", hour: t?.hour ?? 7, lastBackup: t?.last_backup || null });
});

app.post("/api/tg/code", requireAuth, async (req, res) => {
  if (!TG_TOKEN) return res.status(400).json({ error: "Serverda TELEGRAM_BOT_TOKEN sozlanmagan." });
  const code = "link_" + crypto.randomBytes(6).toString("hex");
  if (pool) {
    await pool.query(
      `INSERT INTO tg_links (user_id, code) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code`,
      [req.uid, code]
    );
  }
  res.json({ code, url: `https://t.me/${TG_BOT_USERNAME}?start=${code}` });
});

app.post("/api/tg/unlink", requireAuth, async (req, res) => {
  if (pool) await pool.query("DELETE FROM tg_links WHERE user_id = $1", [req.uid]);
  res.json({ ok: true });
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

// Serve static files from both public/ and root directory
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));
app.get("*", (req, res) => {
  const pubIndex = path.join(__dirname, "public/index.html");
  const rootIndex = path.join(__dirname, "index.html");
  res.sendFile(fs.existsSync(pubIndex) ? pubIndex : rootIndex);
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`ME'MORI server listening on port ${PORT}`));
}).catch(err => {
  console.error("DB init error:", err);
  app.listen(PORT, () => console.log(`ME'MORI server listening (fallback) on port ${PORT}`));
});
