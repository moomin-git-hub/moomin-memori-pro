// Esda qolsin server: accounts, record sync and file attachments on PostgreSQL (Neon).
// Serves the app from ./public and the API under /api. Deploys to Render as one web service.
"use strict";
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const PORT = +process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const MAX_FILE_MB = +process.env.MAX_FILE_MB || 10;
const USER_QUOTA_MB = +process.env.USER_QUOTA_MB || 300;
const PROD = process.env.NODE_ENV === "production";
const COOKIE = "eq_session";
const CRON_KEY = process.env.CRON_KEY || "";

if (!DATABASE_URL) { console.error("DATABASE_URL is not set. Put your Neon connection string there."); process.exit(1); }
if (!JWT_SECRET || JWT_SECRET.length < 24) { console.error("JWT_SECRET must be set to a random string of at least 24 characters."); process.exit(1); }

const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000 });

async function migrate() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS rec_rev;
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      name text NOT NULL DEFAULT '',
      pass text,
      google_sub text UNIQUE,
      picture text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS records (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id text NOT NULL,
      k text NOT NULL,
      u bigint NOT NULL,
      rev bigint NOT NULL DEFAULT nextval('rec_rev'),
      data jsonb NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS records_user_rev ON records (user_id, rev);
    CREATE TABLE IF NOT EXISTS files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL,
      size integer NOT NULL,
      data bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS files_user ON files (user_id);
    CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      keys jsonb NOT NULL,
      hour smallint NOT NULL DEFAULT 7,
      tz text NOT NULL DEFAULT 'Asia/Tashkent',
      last_day text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id);
  `);
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "15mb" }));

/* ── small helpers ── */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, status, error) => res.status(status).json({ error });
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, picture: u.picture || "" });
function setSession(res, user) {
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "90d" });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 90 * 864e5, path: "/" });
}
const auth = wrap(async (req, res, next) => {
  const token = req.cookies[COOKIE];
  if (!token) return fail(res, 401, "Hisobga kiring.");
  let sub;
  try { sub = jwt.verify(token, JWT_SECRET).sub; } catch (e) { return fail(res, 401, "Sessiya tugagan. Qaytadan kiring."); }
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [sub]);
  if (!rows[0]) return fail(res, 401, "Hisob topilmadi.");
  req.user = rows[0];
  next();
});
// A gentle limit on sign-in attempts per address, kept in memory.
const tries = new Map();
function limited(req) {
  const key = req.ip, now = Date.now(), t = (tries.get(key) || []).filter(x => now - x < 15 * 60e3);
  t.push(now); tries.set(key, t);
  return t.length > 30;
}
const cleanEmail = e => String(e || "").trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

/* ── health and config ── */
app.get("/api/health", (req, res) => res.json({ ok: true, app: "esda-qolsin" }));
app.get("/api/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, maxFileMb: MAX_FILE_MB, quotaMb: USER_QUOTA_MB }));

/* ── accounts ── */
app.post("/api/auth/register", wrap(async (req, res) => {
  if (limited(req)) return fail(res, 429, "Urinishlar ko'p. 15 daqiqadan keyin qayta urining.");
  const email = cleanEmail(req.body.email), password = String(req.body.password || ""), name = String(req.body.name || "").trim().slice(0, 80);
  if (!validEmail(email)) return fail(res, 400, "Email manzilini to'g'ri yozing.");
  if (password.length < 8) return fail(res, 400, "Parol kamida 8 belgidan iborat bo'lsin.");
  const hash = await bcrypt.hash(password, 11);
  try {
    const { rows } = await pool.query("INSERT INTO users (email, name, pass) VALUES ($1, $2, $3) RETURNING *", [email, name || email.split("@")[0], hash]);
    setSession(res, rows[0]);
    res.json(publicUser(rows[0]));
  } catch (e) {
    if (e.code === "23505") return fail(res, 409, "Bu email bilan hisob bor. «Kirish»ni tanlang.");
    throw e;
  }
}));
app.post("/api/auth/login", wrap(async (req, res) => {
  if (limited(req)) return fail(res, 429, "Urinishlar ko'p. 15 daqiqadan keyin qayta urining.");
  const email = cleanEmail(req.body.email), password = String(req.body.password || "");
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const u = rows[0];
  if (!u || !u.pass || !(await bcrypt.compare(password, u.pass))) return fail(res, 401, u && !u.pass ? "Bu hisob Google orqali ochilgan. «Google bilan kirish»ni bosing." : "Email yoki parol noto'g'ri.");
  setSession(res, u);
  res.json(publicUser(u));
}));
app.post("/api/auth/google", wrap(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return fail(res, 400, "Google orqali kirish sozlanmagan.");
  const { OAuth2Client } = require("google-auth-library");
  let p;
  try {
    const ticket = await new OAuth2Client(GOOGLE_CLIENT_ID).verifyIdToken({ idToken: String(req.body.credential || ""), audience: GOOGLE_CLIENT_ID });
    p = ticket.getPayload();
  } catch (e) { return fail(res, 401, "Google tasdiqlamadi. Qayta urining."); }
  if (!p || !p.email || p.email_verified === false) return fail(res, 401, "Google hisobidagi email tasdiqlanmagan.");
  const email = cleanEmail(p.email);
  const { rows } = await pool.query(`
    INSERT INTO users (email, name, google_sub, picture) VALUES ($1, $2, $3, $4)
    ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub, picture = EXCLUDED.picture,
      name = CASE WHEN users.name = '' THEN EXCLUDED.name ELSE users.name END
    RETURNING *`, [email, String(p.name || email.split("@")[0]).slice(0, 80), p.sub, p.picture || ""]);
  setSession(res, rows[0]);
  res.json(publicUser(rows[0]));
}));
app.post("/api/auth/logout", (req, res) => { res.clearCookie(COOKIE, { path: "/" }); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json(publicUser(req.user)));

/* ── sync ──
   The client sends the records it changed (each carries "u", its last-edit time) and the cursor it holds.
   A stored record is replaced only by a newer "u". Every write takes a new revision from one sequence,
   so the reply is simply everything of this user with a revision above the cursor, plus the new cursor. */
const KINDS = new Set(["b", "i", "c", "g"]);
app.post("/api/sync", auth, wrap(async (req, res) => {
  const since = Math.max(0, +req.body.since || 0);
  const incoming = Array.isArray(req.body.recs) ? req.body.recs : [];
  if (incoming.length > 5000) return fail(res, 413, "Bir martada juda ko'p yozuv yuborildi.");
  const clean = [];
  for (const r of incoming) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id || r.id.length > 80 || !KINDS.has(r.k)) continue;
    const u = Math.floor(+r.u || 0);
    if (!u) continue;
    const json = JSON.stringify(r);
    if (json.length > 200000) continue;
    clean.push([r.id, r.k, u, json]);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [id, k, u, json] of clean) {
      await client.query(`
        INSERT INTO records (user_id, id, k, u, data) VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (user_id, id) DO UPDATE SET k = EXCLUDED.k, u = EXCLUDED.u, data = EXCLUDED.data, rev = nextval('rec_rev')
        WHERE records.u < EXCLUDED.u`, [req.user.id, id, k, u, json]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  const { rows } = await pool.query("SELECT data, rev FROM records WHERE user_id = $1 AND rev > $2 ORDER BY rev LIMIT 20000", [req.user.id, since]);
  const top = rows.length ? Math.max(...rows.map(r => +r.rev)) : since;
  res.json({ recs: rows.map(r => r.data), since: top });
}));
app.get("/api/export", auth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT data FROM records WHERE user_id = $1 AND NOT (data ? 'del')", [req.user.id]);
  res.setHeader("Content-Disposition", `attachment; filename="esda-qolsin-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: "esda-qolsin", v: 2, saved: new Date().toISOString(), recs: Object.fromEntries(rows.map(r => [r.data.id, r.data])) });
}));

/* ── files attached to notes ── */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 } });
const SAFE_TYPE = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|audio\/[\w.+-]+|video\/(mp4|webm|quicktime)|text\/(plain|markdown|csv)|application\/(msword|vnd\.openxmlformats-officedocument\.[\w.]+|vnd\.ms-excel|vnd\.ms-powerpoint|zip|json))$/;
app.post("/api/files", auth, (req, res, next) => upload.single("file")(req, res, err => {
  if (err) return fail(res, 413, err.code === "LIMIT_FILE_SIZE" ? `Fayl ${MAX_FILE_MB} MB dan katta.` : "Fayl qabul qilinmadi.");
  next();
}), wrap(async (req, res) => {
  const f = req.file;
  if (!f) return fail(res, 400, "Fayl tanlanmadi.");
  const type = SAFE_TYPE.test(f.mimetype) ? f.mimetype : "application/octet-stream";
  const { rows: [q] } = await pool.query("SELECT COALESCE(SUM(size), 0)::bigint AS used FROM files WHERE user_id = $1", [req.user.id]);
  if (+q.used + f.size > USER_QUOTA_MB * 1024 * 1024) return fail(res, 413, `Fayllar uchun joy tugadi (${USER_QUOTA_MB} MB). Keraksiz fayllarni o'chiring.`);
  const name = String(req.body.name || f.originalname || "fayl").slice(0, 160);
  const { rows } = await pool.query("INSERT INTO files (user_id, name, type, size, data) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, type, size", [req.user.id, name, type, f.size, f.buffer]);
  res.json({ ...rows[0], src: "s" });
}));
app.get("/api/files/:id", auth, wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return fail(res, 404, "Fayl topilmadi.");
  const { rows } = await pool.query("SELECT name, type, data FROM files WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  const f = rows[0];
  if (!f) return fail(res, 404, "Fayl topilmadi.");
  const inline = /^(image|audio|video)\/|^application\/pdf$|^text\/plain$/.test(f.type) && f.type !== "image/svg+xml";
  res.setHeader("Content-Type", f.type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.send(f.data);
}));
app.delete("/api/files/:id", auth, wrap(async (req, res) => {
  if (/^[0-9a-f-]{36}$/.test(req.params.id)) await pool.query("DELETE FROM files WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ ok: true });
}));
app.get("/api/usage", auth, wrap(async (req, res) => {
  const { rows: [r] } = await pool.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(size), 0)::bigint AS used FROM files WHERE user_id = $1", [req.user.id]);
  res.json({ files: r.n, usedMb: +(r.used / 1048576).toFixed(1), quotaMb: USER_QUOTA_MB });
}));

/* ── review reminders by web push ──
   VAPID keys are made once and kept in the database, so they survive restarts and redeploys.
   Every few minutes (and on each call to /api/cron) the server looks for subscriptions whose
   chosen hour has come in their own time zone and that were not reminded today. */
const webpush = require("web-push");
let vapid = null;
async function loadVapid() {
  const { rows } = await pool.query("SELECT v FROM kv WHERE k = 'vapid'");
  if (rows[0]) vapid = rows[0].v;
  else {
    vapid = process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE } : webpush.generateVAPIDKeys();
    await pool.query("INSERT INTO kv (k, v) VALUES ('vapid', $1) ON CONFLICT (k) DO NOTHING", [vapid]);
    vapid = (await pool.query("SELECT v FROM kv WHERE k = 'vapid'")).rows[0].v;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:esda-qolsin@example.com", vapid.publicKey, vapid.privateKey);
}
function localNow(tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
  } catch (e) { return localNow("Asia/Tashkent"); }
}
async function dueCount(userId, day) {
  const { rows: [r] } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM records
    WHERE user_id = $1 AND k = 'i' AND NOT (data ? 'del') AND COALESCE(data->>'off', '0') NOT IN ('1', 'true')
      AND data->>'d' <= $2`, [userId, day]);
  return r.n;
}
async function sendTo(sub, payload) {
  try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 6 * 3600 }); return true; }
  catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) await pool.query("DELETE FROM push_subs WHERE endpoint = $1", [sub.endpoint]);
    else console.error("push failed:", e.statusCode || e.message);
    return false;
  }
}
let reminding = false;
async function remind() {
  if (reminding || !vapid) return 0;
  reminding = true;
  let sent = 0;
  try {
    const { rows } = await pool.query("SELECT * FROM push_subs");
    for (const s of rows) {
      const now = localNow(s.tz);
      if (now.hour < s.hour || s.last_day === now.day) continue;
      await pool.query("UPDATE push_subs SET last_day = $1 WHERE endpoint = $2", [now.day, s.endpoint]);
      const n = await dueCount(s.user_id, now.day);
      if (!n) continue;
      if (await sendTo(s, { title: "Esda qolsin", body: `Bugun ${n} ta yozuvni eslash vaqti keldi. Bir necha daqiqa yetadi.`, url: "/#takror", tag: "esda-due" })) sent++;
    }
  } catch (e) { console.error("remind:", e.message); } finally { reminding = false; }
  return sent;
}
app.get("/api/push/key", (req, res) => vapid ? res.json({ key: vapid.publicKey }) : fail(res, 503, "Eslatmalar hali tayyor emas."));
app.post("/api/push/subscribe", auth, wrap(async (req, res) => {
  const sub = req.body.sub || {}, hour = Math.min(23, Math.max(0, Math.floor(+req.body.hour)));
  if (typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return fail(res, 400, "Obuna ma'lumoti noto'g'ri.");
  if (!Number.isFinite(hour)) return fail(res, 400, "Soatni tanlang.");
  const tz = String(req.body.tz || "Asia/Tashkent").slice(0, 64);
  const today = localNow(tz);
  await pool.query(`
    INSERT INTO push_subs (endpoint, user_id, keys, hour, tz, last_day) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys, hour = EXCLUDED.hour, tz = EXCLUDED.tz, last_day = EXCLUDED.last_day`,
    [sub.endpoint, req.user.id, { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, hour, tz, today.hour >= hour ? today.day : ""]);
  res.json({ on: true, hour });
}));
app.post("/api/push/unsubscribe", auth, wrap(async (req, res) => {
  await pool.query("DELETE FROM push_subs WHERE endpoint = $1 AND user_id = $2", [String(req.body.endpoint || ""), req.user.id]);
  res.json({ on: false });
}));
app.get("/api/push/status", auth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT hour FROM push_subs WHERE endpoint = $1 AND user_id = $2", [String(req.query.endpoint || ""), req.user.id]);
  res.json(rows[0] ? { on: true, hour: rows[0].hour } : { on: false });
}));
app.post("/api/push/test", auth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM push_subs WHERE user_id = $1", [req.user.id]);
  if (!rows.length) return fail(res, 400, "Avval eslatmani yoqing.");
  const n = await dueCount(req.user.id, localNow(rows[0].tz).day);
  let ok = 0;
  for (const s of rows) if (await sendTo(s, { title: "Esda qolsin", body: n ? `Sinov: bugun ${n} ta takror bor.` : "Sinov: eslatmalar ishlayapti.", url: "/#takror", tag: "esda-test" })) ok++;
  res.json({ sent: ok });
}));
// Render's free plan sleeps after 15 idle minutes; an outside pinger (cron-job.org) calling this
// every 15 minutes keeps reminders on time.
app.get("/api/cron", wrap(async (req, res) => {
  if (!CRON_KEY || req.query.key !== CRON_KEY) return fail(res, 403, "Kalit noto'g'ri.");
  res.json({ sent: await remind() });
}));

/* ── the app itself ── */
app.use("/api", (req, res) => fail(res, 404, "Bunday manzil yo'q."));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) { if (/(index\.html|sw\.js)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); },
}));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => { console.error(err); fail(res, 500, "Serverda xato yuz berdi. Birozdan keyin qayta urining."); });

migrate().then(loadVapid).then(() => {
  setInterval(remind, 5 * 60 * 1000);
  setTimeout(remind, 15000);
  app.listen(PORT, () => console.log(`Esda qolsin is listening on ${PORT}`));
}).catch(e => { console.error("Database setup failed:", e.message); process.exit(1); });
