// ME'MORI server (formerly Esda qolsin): accounts, record sync and file attachments on PostgreSQL (Neon).
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
const APP = () => `ME'MORI ${new Date().getFullYear()}`;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
// Neon Object Storage (S3-compatible). When these are set, files live in the bucket instead of the database.
const S3_ON = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_ENDPOINT_URL_S3);
const S3_BUCKET = process.env.S3_BUCKET || "memori-files";
const STORAGE_LIMIT_GB = +process.env.STORAGE_LIMIT_GB || 5;   // Neon Free: 5 GB of object storage per project

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
    ALTER TABLE files ADD COLUMN IF NOT EXISTS store text NOT NULL DEFAULT 'db';
    ALTER TABLE files ALTER COLUMN data DROP NOT NULL;
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key text UNIQUE;
    CREATE TABLE IF NOT EXISTS tg_links (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_id bigint UNIQUE NOT NULL,
      name text NOT NULL DEFAULT '',
      hour smallint NOT NULL DEFAULT 7,
      last_day text NOT NULL DEFAULT '',
      last_backup timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_key text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_model text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS fwd_out (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, id text NOT NULL, tries integer NOT NULL DEFAULT 0, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, id));
    ALTER TABLE tg_links ADD COLUMN IF NOT EXISTS docs_on boolean NOT NULL DEFAULT true;
    ALTER TABLE tg_links ADD COLUMN IF NOT EXISTS docs_hour smallint NOT NULL DEFAULT 21;
    ALTER TABLE tg_links ADD COLUMN IF NOT EXISTS docs_day text NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS tg_codes (code text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, exp timestamptz NOT NULL);
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
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, picture: u.picture || "", ai: !!aiFor(u) });
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
app.get("/api/config", (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, maxFileMb: MAX_FILE_MB, quotaMb: USER_QUOTA_MB, ai: !!ENV_PROV, telegram: !!TG_TOKEN, storage: S3_ON ? "neon-object-storage" : "database" }));

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
const KINDS = new Set(["b", "i", "c", "g", "s", "n"]);   // source, note, settings, goal, study session, idea
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
  const sess = incoming.filter(r => r && r.k === "s" && typeof r.id === "string");
  if (sess.length) queueSessions(req.user.id, sess).catch(e => console.error("vaqt queue:", e.message));
  const { rows } = await pool.query("SELECT data, rev FROM records WHERE user_id = $1 AND rev > $2 ORDER BY rev LIMIT 20000", [req.user.id, since]);
  const top = rows.length ? Math.max(...rows.map(r => +r.rev)) : since;
  res.json({ recs: rows.map(r => r.data), since: top });
}));
async function backupOf(userId) {
  const { rows } = await pool.query("SELECT data FROM records WHERE user_id = $1 AND NOT (data ? 'del')", [userId]);
  return { app: "esda-qolsin", v: 2, saved: new Date().toISOString(), recs: Object.fromEntries(rows.map(r => [r.data.id, r.data])) };
}
app.get("/api/export", auth, wrap(async (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="memori-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(await backupOf(req.user.id));
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
  if (S3_ON) {
    const id = crypto.randomUUID();
    try { await s3Put(fileKey(req.user.id, id), f.buffer, type); }
    catch (e) { console.error("s3 put:", e.message); return fail(res, 502, "Fayl omborga yuklanmadi. Birozdan keyin qayta urining."); }
    const { rows } = await pool.query("INSERT INTO files (id, user_id, name, type, size, data, store) VALUES ($1, $2, $3, $4, $5, NULL, 's3') RETURNING id, name, type, size", [id, req.user.id, name, type, f.size]);
    usageCache = null;
    return res.json({ ...rows[0], src: "s" });
  }
  const { rows } = await pool.query("INSERT INTO files (user_id, name, type, size, data) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, type, size", [req.user.id, name, type, f.size, f.buffer]);
  res.json({ ...rows[0], src: "s" });
}));
app.get("/api/files/:id", auth, wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return fail(res, 404, "Fayl topilmadi.");
  const { rows } = await pool.query("SELECT name, type, data, store FROM files WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  const f = rows[0];
  if (!f) return fail(res, 404, "Fayl topilmadi.");
  const inline = /^(image|audio|video)\/|^application\/pdf$|^text\/plain$/.test(f.type) && f.type !== "image/svg+xml";
  if (f.store === "s3") {
    if (!S3_ON) return fail(res, 503, "Fayllar ombori sozlanmagan.");
    // The bucket is private: the owner gets a link that works for one hour.
    const url = await s3Link(fileKey(req.user.id, req.params.id), `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`, f.type);
    res.setHeader("Cache-Control", "private, max-age=3000");
    return res.redirect(302, url);
  }
  res.setHeader("Content-Type", f.type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.send(f.data);
}));
app.delete("/api/files/:id", auth, wrap(async (req, res) => {
  if (/^[0-9a-f-]{36}$/.test(req.params.id)) {
    const { rows } = await pool.query("DELETE FROM files WHERE id = $1 AND user_id = $2 RETURNING store", [req.params.id, req.user.id]);
    if (rows[0] && rows[0].store === "s3" && S3_ON) { await s3Del(fileKey(req.user.id, req.params.id)).catch(e => console.error("s3 delete:", e.message)); usageCache = null; }
  }
  res.json({ ok: true });
}));
/* ── Neon Object Storage ── */
const fileKey = (userId, id) => `u/${userId}/${id}`;
let s3 = null, S3c = null;
function s3c() {
  if (!s3) {
    S3c = require("@aws-sdk/client-s3");
    s3 = new S3c.S3Client({
      region: process.env.AWS_REGION || "us-east-1", endpoint: process.env.AWS_ENDPOINT_URL_S3, forcePathStyle: true,
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return s3;
}
const s3Put = (Key, Body, ContentType) => s3c().send(new S3c.PutObjectCommand({ Bucket: S3_BUCKET, Key, Body, ContentType }));
const s3Del = Key => s3c().send(new S3c.DeleteObjectCommand({ Bucket: S3_BUCKET, Key }));
async function s3Link(Key, disposition, type) {
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  return getSignedUrl(s3c(), new S3c.GetObjectCommand({ Bucket: S3_BUCKET, Key, ResponseContentDisposition: disposition, ResponseContentType: type }), { expiresIn: 3600 });
}
async function ensureBucket() {
  try { await s3c().send(new S3c.HeadBucketCommand({ Bucket: S3_BUCKET })); }
  catch (e) {
    if (e.$metadata && e.$metadata.httpStatusCode === 403) throw new Error(`no access to bucket ${S3_BUCKET}`);
    await s3c().send(new S3c.CreateBucketCommand({ Bucket: S3_BUCKET }));
    console.log(`Object storage: bucket ${S3_BUCKET} created.`);
  }
}
// The whole bucket, counted object by object (Neon has no size API); kept for five minutes.
let usageCache = null;
async function bucketUsage() {
  if (usageCache && Date.now() - usageCache.at < 5 * 60e3) return usageCache;
  let bytes = 0, objects = 0, token;
  do {
    const r = await s3c().send(new S3c.ListObjectsV2Command({ Bucket: S3_BUCKET, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) { bytes += +o.Size || 0; objects++; }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return usageCache = { bytes, objects, at: Date.now() };
}
// Files saved in the database before the bucket existed move over in the background, a few at a time.
const moving = { running: false, moved: 0, failed: 0, last: "" };
async function moveFilesToBucket() {
  if (!S3_ON || moving.running) return;
  moving.running = true;
  try {
    for (;;) {
      const { rows } = await pool.query("SELECT id, user_id, type FROM files WHERE store = 'db' AND data IS NOT NULL ORDER BY created_at LIMIT 10");
      if (!rows.length) break;
      for (const f of rows) {
        try {
          const { rows: [d] } = await pool.query("SELECT data FROM files WHERE id = $1", [f.id]);
          await s3Put(fileKey(f.user_id, f.id), d.data, f.type);
          await pool.query("UPDATE files SET store = 's3', data = NULL WHERE id = $1", [f.id]);
          moving.moved++;
        } catch (e) { moving.failed++; moving.last = e.message; console.error("move file:", e.message); await pool.query("UPDATE files SET store = 'db-retry' WHERE id = $1", [f.id]); }
      }
      usageCache = null;
    }
    if (moving.moved) console.log(`Object storage: ${moving.moved} files moved from the database.`);
    await pool.query("UPDATE files SET store = 'db' WHERE store = 'db-retry'");   // try those again next start
  } finally { moving.running = false; }
}
app.get("/api/storage", auth, wrap(async (req, res) => {
  const { rows: [mine] } = await pool.query("SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes FROM files WHERE user_id = $1", [req.user.id]);
  const { rows: [left] } = await pool.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(size), 0)::bigint AS bytes FROM files WHERE store <> 's3'");
  const out = { backend: S3_ON ? "neon-object-storage" : "database", bucket: S3_ON ? S3_BUCKET : "", limitBytes: STORAGE_LIMIT_GB * 1024 ** 3, userQuotaBytes: USER_QUOTA_MB * 1048576,
    mine: { files: mine.files, bytes: +mine.bytes }, inDatabase: { files: left.n, bytes: +left.bytes }, moving: { ...moving } };
  if (S3_ON) {
    try { const u = await bucketUsage(); out.used = { bytes: u.bytes, objects: u.objects, checkedAt: new Date(u.at).toISOString() }; }
    catch (e) { out.error = "Omborga ulanib bo'lmadi: " + e.message; }
  } else {
    const { rows: [db] } = await pool.query("SELECT pg_database_size(current_database())::bigint AS bytes");
    out.used = { bytes: +db.bytes, objects: left.n }; out.limitBytes = 512 * 1048576;   // Neon Free database: 0.5 GB
  }
  res.json(out);
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
      if (await sendTo(s, { title: APP(), body: `Bugun ${n} ta yozuvni eslash vaqti keldi. Bir necha daqiqa yetadi.`, url: "/#takror", tag: "esda-due" })) sent++;
    }
  } catch (e) { console.error("remind:", e.message); } finally { reminding = false; }
  await telegramRound().catch(e => console.error("telegram:", e.message));
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
  for (const s of rows) if (await sendTo(s, { title: APP(), body: n ? `Sinov: bugun ${n} ta takror bor.` : "Sinov: eslatmalar ishlayapti.", url: "/#takror", tag: "esda-test" })) ok++;
  res.json({ sent: ok });
}));
// Render's free plan sleeps after 15 idle minutes; an outside pinger (cron-job.org) calling this
// every 15 minutes keeps reminders on time.
app.get("/api/cron", wrap(async (req, res) => {
  if (!CRON_KEY || req.query.key !== CRON_KEY) return fail(res, 403, "Kalit noto'g'ri.");
  res.json({ sent: await remind() });
}));

/* ── one place that turns "what I learned" into records ──
   Used by the Telegram bot and by other apps (Vaqt Banki, Mo'min). A message like
   «O'tkan kunlar 40-65 bet 30 daq: Otabek Marg'ilonga keldi» becomes a note on that
   source, a study session (25 bet, 30 daqiqa) and the source's new place. */
const UNIT_OF_KIND = { badiiy: "bet", ilmiy: "bet", sher: "bet", diniy: "bet", kurs: "dars", til: "dars", video: "daqiqa", podkast: "daqiqa" };
const fold = s => String(s || "").toLowerCase().replace(/[ʻʼ‘’`´]/g, "'").replace(/\s+/g, " ").trim();
const rid = () => crypto.randomBytes(8).toString("hex");
function addDay(day, n) { const [y, m, d] = day.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
async function recordsOf(userId, kinds) {
  const { rows } = await pool.query("SELECT data FROM records WHERE user_id = $1 AND k = ANY($2) AND NOT (data ? 'del')", [userId, kinds]);
  return rows.map(r => r.data);
}
async function saveRecords(userId, list) {
  for (const r of list) {
    await pool.query(`
      INSERT INTO records (user_id, id, k, u, data) VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (user_id, id) DO UPDATE SET k = EXCLUDED.k, u = EXCLUDED.u, data = EXCLUDED.data, rev = nextval('rec_rev')
      WHERE records.u < EXCLUDED.u`, [userId, r.id, r.k, r.u, JSON.stringify(r)]);
  }
}
// Reads «<source title> <amount> <unit> <minutes>: <text>»; every part is optional.
function parseEntry(text, sources) {
  let t = String(text || "").trim(), src = null;
  const ft = fold(t);
  for (const b of [...sources].sort((x, y) => y.title.length - x.title.length)) {
    const ftl = fold(b.title);
    if (ftl && ft.startsWith(ftl)) { src = b; t = t.slice(b.title.length); break; }
  }
  if (!src) { const m = t.match(/^#(\S+)/); if (m) { const k = fold(m[1]).replace(/_/g, " "); src = sources.find(b => fold(b.title).startsWith(k)) || null; if (src) t = t.slice(m[0].length); } }
  // «Sapiens 30 bet: …» with no such source yet: the words before the amount name a new one.
  let title = "", unit = "";
  if (!src) { const m = t.match(/^(\D{2,80}?)\s+(?=\d{1,5}(?:\s*[-–—]\s*\d{1,5})?\s*(bet|dars|daqiqa|daq|min|soat)\b)/i); if (m) { title = m[1].replace(/[\s,.:;—–-]+$/, ""); unit = /^bet$/i.test(m[2]) ? "bet" : /^dars$/i.test(m[2]) ? "dars" : ""; t = t.slice(m[0].length); } }
  t = t.replace(/^[\s,.:;—–-]+/, "");
  let from = 0, to = 0, qty = 0, minutes = 0;
  const am = t.match(/^(\d{1,5})(?:\s*[-–—]\s*(\d{1,5}))?\s*(bet|b\b|dars|daqiqa|daq|min|soat)?(?=[\s,.:;—–-]|$)[\s,.:;—–-]*/i);
  if (am) {
    const a = +am[1], b = am[2] ? +am[2] : 0, w = (am[3] || "").toLowerCase();
    if (/^(daqiqa|daq|min)$/.test(w)) minutes = a;
    else if (w === "soat") minutes = a * 60;
    else if (b) { from = a; to = b; qty = Math.max(0, b - a + 1); }
    else qty = a;
    t = t.slice(am[0].length);
  }
  const mm = t.match(/^(\d{1,4})\s*(daqiqa|daq|min|soat)\b[\s,.:;—–-]*/i);
  if (mm) { minutes = /soat/i.test(mm[2]) ? +mm[1] * 60 : +mm[1]; t = t.slice(mm[0].length); }
  return { src, title, unit, from, to, qty, minutes, text: t.trim() };
}
async function sourceFor(userId, title, kind) {
  title = String(title).slice(0, 160);
  const found = (await recordsOf(userId, ["b"])).find(x => fold(x.title) === fold(title));
  if (found) return found;
  const now = Date.now(), b = { id: rid(), k: "b", title, author: "", kind: kind && UNIT_OF_KIND[kind] !== undefined ? kind : "boshqa", pages: 0, cur: 0, status: "reading", c: now, fin: 0, u: now };
  await saveRecords(userId, [b]);
  return b;
}
async function logEntry(userId, e) {
  const sources = (await recordsOf(userId, ["b"])).filter(b => b.status !== "done" || e.title);
  const p = e.parsed || parseEntry(e.raw || "", sources);
  let b = p.src;
  if (!b && !e.title && p.title) { e = { ...e, title: p.title, unit: e.unit || p.unit }; b = sources.find(x => fold(x.title) === fold(p.title)) || null; }
  if (!b && e.title) b = sources.find(x => fold(x.title) === fold(e.title)) || null;
  if (!b) b = await sourceFor(userId, e.title || "Telegram yozuvlari", e.kind || { bet: "ilmiy", dars: "kurs", daqiqa: "video" }[e.unit]);
  const now = Math.max(Date.now(), (b.u || 0) + 1), day = localNow("Asia/Tashkent").day, out = [];
  const unit = UNIT_OF_KIND[b.kind] || "";
  let { from, to, qty, minutes, text } = { from: +e.from || p.from, to: +e.to || p.to, qty: +e.qty || p.qty, minutes: +e.minutes || p.minutes, text: e.text != null ? String(e.text).trim() : p.text };
  if (unit && qty && !from && !to && unit !== "daqiqa") { from = (b.cur || 0) + 1; to = (b.cur || 0) + qty; }
  if (unit === "daqiqa" && !qty && minutes) qty = minutes;
  const range = unit && from ? (to > from ? `${from}–${to}-${unit === "bet" ? "betlar" : unit === "dars" ? "darslar" : "daqiqalar"}` : `${from}-${unit}`) : "";
  const ref = [range, e.via || ""].filter(Boolean).join(" · ") || "Tez yozuv";
  if (text) out.push({ id: rid(), k: "i", b: b.id, t: "recall", q: "", a: text.slice(0, 4000), r: ref, f: from, e: to, c: now + 1, s: 0, d: addDay(day, 1), n: 0, l: 0, h: [], via: e.via || "", u: now });
  if (qty || minutes) out.push({ id: rid(), k: "s", b: b.id, day, qty: unit ? qty : 0, unit, min: minutes, from, to, c: now + 2, via: e.via || "", u: now });
  if (to > (b.cur || 0) && unit) out.push({ ...b, cur: b.pages ? Math.min(b.pages, to) : to, u: now + 3 });
  if (!out.length) return null;
  await saveRecords(userId, out);
  queueSessions(userId, out.filter(r => r.k === "s")).catch(e => console.error("vaqt queue:", e.message));
  return { title: b.title, unit, qty, minutes, note: !!text, from, to };
}
const UNIT_WORD = { bet: "bet", dars: "dars", daqiqa: "daqiqa" };
const entryLine = r => [r.qty && r.unit ? `+${r.qty} ${UNIT_WORD[r.unit]}` : "", r.minutes && r.unit !== "daqiqa" ? `${r.minutes} daqiqa` : "", r.note ? "yozuv saqlandi, ertaga so'raladi" : ""].filter(Boolean).join(" · ");

/* XOTIR, the same way the app counts it: each note is worth 10 once recalled in a review,
   then by its chance of still being remembered, R = (1 + t / 9S)^-1, S the gap of its step. */
const LADDER = [1, 3, 7, 14, 30, 60, 120, 240], XV = 10;
const dDiff = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 864e5);
function memoryOf(notes, day, from) {
  let bal = 0, start = 0, gain = 0, lost = 0, pending = 0;
  const before = addDay(from, -1);
  for (const i of notes) {
    let proven = false, s = 0, last = "", vStart = null;
    const val = d => proven ? XV / (1 + Math.max(0, dDiff(d, last)) / (9 * LADDER[s])) : 0;
    for (const [d, g] of i.h || []) {
      if (vStart === null && d > before) vStart = val(before);
      const v = val(d);
      if (g >= 1) { if (d >= from) gain += XV - v; proven = true; s = g === 3 ? Math.min(s + 2, 7) : g === 2 ? Math.min(s + 1, 7) : s; }
      else { if (d >= from) lost += v; proven = false; s = 0; }
      last = d;
    }
    if (vStart === null) vStart = val(before);
    start += vStart; bal += val(day);
    if (!proven && !i.off) pending++;
  }
  const net = bal - start;
  return { xotir: Math.round(bal), kirim: Math.round(gain), unutildi: Math.round(lost), eskirdi: Math.max(0, Math.round(gain - lost - net)), pending };
}
// A month and a lifetime in one glance: XOTIR, notes, pages, lessons, minutes, words, finished sources.
async function ledger(userId) {
  const recs = await recordsOf(userId, ["b", "i", "s"]);
  const books = new Map(recs.filter(r => r.k === "b").map(b => [b.id, b]));
  const day = localNow("Asia/Tashkent").day, month = day.slice(0, 7);
  const L = () => ({ notes: 0, bet: 0, dars: 0, daqiqa: 0, min: 0, words: 0, done: 0, forgot: 0, hard: 0, good: 0, easy: 0 });
  const m = L(), all = L();
  const dayOf = c => new Date(c + 5 * 3600e3).toISOString().slice(0, 10);
  for (const r of recs) {
    if (r.k === "i" && !r.rev && books.has(r.b)) {
      const d = dayOf(r.c || 0), w = r.t === "card" && books.get(r.b).kind === "til";
      for (const x of d.startsWith(month) ? [m, all] : [all]) { x.notes++; if (w) x.words++; }
    }
    if (r.k === "i" && books.has(r.b)) for (const [d, g] of r.h || []) for (const x of String(d).startsWith(month) ? [m, all] : [all]) x[["forgot", "hard", "good", "easy"][g] || "good"]++;
    if (r.k === "s") for (const x of String(r.day).startsWith(month) ? [m, all] : [all]) { if (r.unit && UNIT_WORD[r.unit]) x[r.unit] += +r.qty || 0; x.min += (+r.min || 0) || (r.unit === "daqiqa" ? +r.qty || 0 : 0); }
    if (r.k === "b" && r.status === "done" && r.fin) for (const x of dayOf(r.fin).startsWith(month) ? [m, all] : [all]) x.done++;
  }
  const notes = recs.filter(r => r.k === "i" && !r.rev && books.has(r.b));
  Object.assign(m, memoryOf(notes, day, month + "-01"));
  Object.assign(all, memoryOf(notes, day, "1970-01-01"));
  for (const x of [m, all]) x.chiqim = x.unutildi + x.eskirdi;
  return { day, month: m, all, xotir: all.xotir, due: await dueCount(userId, day) };
}
const ledgerText = (L, head) => [`${head} +${L.kirim} / −${L.chiqim} XOTIR`, `• ${L.notes} ta yangi yozuv`, L.bet ? `• ${L.bet} bet o'qildi` : "", L.dars ? `• ${L.dars} ta dars` : "", L.min ? `• ${Math.floor(L.min / 60)} soat ${L.min % 60} daqiqa` : "", L.words ? `• ${L.words} ta yangi so'z` : "", L.done ? `• ${L.done} ta manba tugatildi` : ""].filter(Boolean).join("\n");

/* ── cards from a photo or text, by Gemini (free tier) or Claude ── */
const AI_RULES = "You make retrieval-practice flashcards for a learner. From the material below, write 3 to 10 short question-answer pairs that test its most important facts, terms, names, dates and ideas. For foreign-language vocabulary, make pairs of «word or phrase» and its Uzbek translation. Otherwise write in Uzbek, Latin script. Use only what is in the material. Questions must need real recall, not yes or no. Reply with only a JSON array like [{\"q\":\"...\",\"a\":\"...\"}].";
function pairsFrom(text) {
  const m = String(text || "").match(/\[[\s\S]*\]/);
  let arr = [];
  try { arr = JSON.parse(m ? m[0] : text); } catch (e) { arr = []; }
  return (Array.isArray(arr) ? arr : []).map(x => ({ q: String((x && x.q) || "").trim().slice(0, 300), a: String((x && x.a) || "").trim().slice(0, 600) })).filter(x => x.q && x.a).slice(0, 12);
}
/* The model to ask: the key the person saved in Settings → «AI kaliti», otherwise the server's own.
   The key's shape tells the provider: «AIza…» Google Gemini, «sk-ant-…» Anthropic Claude, «sk-…» OpenAI. */
function provOf(key, model) {
  key = String(key || "").trim();
  if (!key) return null;
  if (/^sk-ant-/.test(key)) return { kind: "anthropic", key, model: model || ANTHROPIC_MODEL };
  if (/^sk-/.test(key)) return { kind: "openai", key, model: model || process.env.OPENAI_MODEL || "gpt-4o-mini" };
  return { kind: "gemini", key, model: model || GEMINI_MODEL };
}
const ENV_PROV = GEMINI_KEY ? provOf(GEMINI_KEY, GEMINI_MODEL) : ANTHROPIC_KEY ? provOf(ANTHROPIC_KEY, ANTHROPIC_MODEL) : process.env.OPENAI_API_KEY ? provOf(process.env.OPENAI_API_KEY) : null;
function aiFor(user) { return (user && user.ai_key && provOf(user.ai_key, user.ai_model)) || ENV_PROV; }
async function aiUserProv(userId) { const { rows } = await pool.query("SELECT ai_key, ai_model FROM users WHERE id = $1", [userId]); return aiFor(rows[0]); }
const PROV_NAME = { gemini: "Gemini", anthropic: "Claude", openai: "OpenAI" };
async function aiCall(prov, turns, opt = {}) {
  // turns: [{role: "user"|"assistant", content: string}]; opt.media on the last user turn; opt.json asks for JSON
  if (!prov) throw Object.assign(new Error("AI kaliti kiritilmagan. Sozlamalar → «AI kaliti»."), { user: 1 });
  const ctl = AbortSignal.timeout(opt.timeout || 90000);
  let r, j;
  if (prov.kind === "gemini") {
    const contents = turns.map((t, k) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }, ...(opt.media && k === turns.length - 1 ? [{ inline_data: { mime_type: opt.media.mime, data: opt.media.data } }] : [])] }));
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${prov.model}:generateContent`, { method: "POST", signal: ctl,
      headers: { "Content-Type": "application/json", "x-goog-api-key": prov.key },
      body: JSON.stringify({ contents, generationConfig: opt.json ? { responseMimeType: "application/json", temperature: 0.3 } : { temperature: opt.temp == null ? 0.5 : opt.temp } }) });
    j = await r.json().catch(() => null);
    if (!r.ok) throw provErr(prov, r.status, j && j.error && j.error.message);
    const c = (j.candidates || [])[0];
    if (!c || !c.content) throw provErr(prov, 200, (j.promptFeedback && j.promptFeedback.blockReason) ? "so'rov bloklandi" : "bo'sh javob");
    return c.content.parts.map(p => p.text || "").join("");
  }
  if (prov.kind === "anthropic") {
    const msgs = turns.map((t, k) => ({ role: t.role === "assistant" ? "assistant" : "user", content: opt.media && k === turns.length - 1 ? [{ type: "image", source: { type: "base64", media_type: opt.media.mime, data: opt.media.data } }, { type: "text", text: t.content }] : t.content }));
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl,
      headers: { "Content-Type": "application/json", "x-api-key": prov.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: prov.model, max_tokens: opt.max || 2000, messages: msgs }) });
    j = await r.json().catch(() => null);
    if (!r.ok) throw provErr(prov, r.status, j && j.error && j.error.message);
    return (j.content || []).map(c => c.text || "").join("");
  }
  const msgs = turns.map((t, k) => ({ role: t.role === "assistant" ? "assistant" : "user", content: opt.media && k === turns.length - 1 ? [{ type: "text", text: t.content }, { type: "image_url", image_url: { url: `data:${opt.media.mime};base64,${opt.media.data}` } }] : t.content }));
  r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", signal: ctl,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + prov.key },
    body: JSON.stringify({ model: prov.model, messages: msgs, ...(opt.json ? { response_format: { type: "json_object" } } : {}) }) });
  j = await r.json().catch(() => null);
  if (!r.ok) throw provErr(prov, r.status, j && j.error && j.error.message);
  return ((j.choices || [])[0] || { message: { content: "" } }).message.content || "";
}
function provErr(prov, status, msg) {
  const m = String(msg || "");
  const why = status === 401 || status === 403 || /api key|API_KEY_INVALID|invalid x-api-key|Incorrect API key/i.test(m) ? "kalit noto'g'ri yoki o'chirilgan"
    : status === 429 || /quota|rate/i.test(m) ? "limit tugadi yoki so'rovlar juda ko'p — birozdan keyin urining"
    : status === 404 || /model/i.test(m) && /not found|does not exist/i.test(m) ? "bunday model topilmadi"
    : status >= 500 ? "xizmat vaqtincha ishlamayapti" : m.slice(0, 160) || `xato ${status}`;
  return Object.assign(new Error(`${PROV_NAME[prov.kind]}: ${why}`), { user: 1, status });
}
async function aiAsk(prompt, media, json, prov) { return aiCall(prov || ENV_PROV, [{ role: "user", content: prompt }], { media, json, temp: json ? 0.3 : 0.2 }); }
async function aiCards({ text, image, title }, prov) {
  const head = `${AI_RULES}\n\n${title ? `Source: ${title}\n` : ""}`;
  if (image) return pairsFrom(await aiAsk(`${head}The material is the photographed page in the image. Reply with only a JSON array.`, image, true, prov));
  return pairsFrom(await aiAsk(`${head}Material:\n${String(text).slice(0, 12000)}\n\nReply with only a JSON array.`, null, true, prov));
}
// A conversation (study assistant, Socratic exam, find-the-mistake, glossary) with the same model.
async function aiChat(messages, prov) {
  const turns = messages.filter(m => m && typeof m.content === "string" && m.content.trim()).slice(-30).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.slice(0, 12000) }));
  while (turns.length && turns[0].role === "assistant") turns.shift();
  // providers want user/assistant turns to alternate: join neighbours of the same role
  const alt = []; for (const t of turns) { const l = alt[alt.length - 1]; if (l && l.role === t.role) l.content += "\n\n" + t.content; else alt.push({ ...t }); }
  if (!alt.length) return "";
  return aiCall(prov, alt, { max: 1500 });
}
// Settings → «AI kaliti»: the person's own key, checked before it is kept.
app.get("/api/ai", auth, (req, res) => {
  const p = aiFor(req.user), own = !!req.user.ai_key;
  res.json({ on: !!p, own, provider: p ? PROV_NAME[p.kind] : "", model: p ? p.model : "", hint: own ? req.user.ai_key.slice(0, 6) + "…" + req.user.ai_key.slice(-4) : "" });
});
app.post("/api/ai/key", auth, wrap(async (req, res) => {
  const key = String(req.body.key || "").trim(), model = String(req.body.model || "").trim().slice(0, 80);
  if (!key) { await pool.query("UPDATE users SET ai_key = NULL, ai_model = NULL WHERE id = $1", [req.user.id]); return res.json({ on: !!ENV_PROV, own: false, provider: ENV_PROV ? PROV_NAME[ENV_PROV.kind] : "" }); }
  if (key.length < 20 || key.length > 300 || /\s/.test(key)) return fail(res, 400, "Kalit noto'g'ri ko'rinishda. To'liq nusxalang.");
  const p = provOf(key, model || null);
  try { const t = await aiCall(p, [{ role: "user", content: "Reply with the single word: OK" }], { max: 20, temp: 0, timeout: 30000 }); if (!t) throw new Error("bo'sh javob"); }
  catch (e) { return fail(res, 400, e.user ? e.message + ". Kalit saqlanmadi." : "Kalitni tekshirib bo'lmadi: " + e.message); }
  await pool.query("UPDATE users SET ai_key = $2, ai_model = $3 WHERE id = $1", [req.user.id, key, model || null]);
  res.json({ on: true, own: true, provider: PROV_NAME[p.kind], model: p.model, hint: key.slice(0, 6) + "…" + key.slice(-4) });
}));
app.post("/api/ai/chat", auth, wrap(async (req, res) => {
  const prov = aiFor(req.user);
  if (!prov) return fail(res, 400, "AI kaliti kiritilmagan. Sozlamalar → «AI kaliti».");
  if (!Array.isArray(req.body.messages)) return fail(res, 400, "Xabarlar yo'q.");
  try { res.json({ text: await aiChat(req.body.messages, prov) }); }
  catch (e) { console.error("ai chat:", e.message); fail(res, 502, e.user ? e.message : "Sun'iy intellekt javob bermadi. Birozdan keyin qayta urining."); }
}));
app.post("/api/ai/cards", auth, wrap(async (req, res) => {
  const prov = aiFor(req.user);
  if (!prov) return fail(res, 400, "AI kaliti kiritilmagan. Sozlamalar → «AI kaliti».");
  const img = req.body.image, text = String(req.body.text || "").trim();
  let image = null;
  if (img) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(img));
    if (!m) return fail(res, 400, "Rasm o'qilmadi. JPG yoki PNG tanlang.");
    image = { mime: m[1], data: m[2] };
  } else if (!text) return fail(res, 400, "Matn yoki rasm yuboring.");
  try { res.json({ cards: await aiCards({ text, image, title: String(req.body.title || "").slice(0, 160) }, prov) }); }
  catch (e) { console.error("ai:", e.message); fail(res, 502, e.user ? e.message : "Sun'iy intellekt javob bermadi. Birozdan keyin qayta urining."); }
}));

/* ── other apps: Vaqt Banki, Mo'min ──
   Each account can make one key. With it another app reads today's summary or logs study time.
   GET  /api/ext/summary?key=…          → due reviews, this month and lifetime totals
   POST /api/ext/log?key=…  {title, text, qty, unit, from, to, minutes, kind} → saved like a quick entry
   unit is bet, dars or daqiqa; it picks the kind of a source that does not exist yet. */
app.get("/api/key", auth, (req, res) => res.json({ key: req.user.api_key || "" }));
app.post("/api/key", auth, wrap(async (req, res) => {
  const key = "eq_" + crypto.randomBytes(18).toString("hex");
  await pool.query("UPDATE users SET api_key = $1 WHERE id = $2", [key, req.user.id]);
  res.json({ key });
}));
app.delete("/api/key", auth, wrap(async (req, res) => { await pool.query("UPDATE users SET api_key = NULL WHERE id = $1", [req.user.id]); res.json({ key: "" }); }));
app.use("/api/ext", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Esda-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const keyUser = wrap(async (req, res, next) => {
  const key = String(req.get("X-Esda-Key") || req.query.key || "");
  if (!/^eq_[0-9a-f]{36}$/.test(key)) return fail(res, 401, "Kalit noto'g'ri.");
  const { rows } = await pool.query("SELECT * FROM users WHERE api_key = $1", [key]);
  if (!rows[0]) return fail(res, 401, "Kalit noto'g'ri.");
  req.user = rows[0]; next();
});
app.get("/api/ext/summary", keyUser, wrap(async (req, res) => res.json({ app: "esda-qolsin", ...(await ledger(req.user.id)), url: PUBLIC_URL || "" })));
app.post("/api/ext/log", keyUser, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title && !b.text && !b.minutes) return fail(res, 400, "title, text yoki minutes kerak.");
  const r = await logEntry(req.user.id, { title: b.title, text: b.text || "", qty: b.qty, from: b.from, to: b.to, minutes: b.minutes, kind: b.kind, unit: b.unit, via: String(b.via || "Boshqa ilova").slice(0, 40), parsed: { src: null, from: 0, to: 0, qty: 0, minutes: 0, text: "" } });
  res.json({ ok: !!r, ...(r || {}) });
}));

/* ── the four apps as one: Mo'min, Vaqt Banki, Hisob ──
   Pairing: every app shows a link code «https://<app>/link#<key>». The «Ulash» button opens the other app's /link
   page, the person allows it there, and the code comes back in the address (#link=…&from=vaqt).
   • Mo'min sends its learning sections here (POST /api/ext/mirror): words, cards, ayahs, hadith, quotes,
     the book being read. They become sources and cards; review progress made here is never overwritten.
   • Study and review time is forwarded to Vaqt Banki (POST <vaqt>/api/ext/time), one entry per session,
     updated in place when the session changes. Failed sends wait in fwd_out and are retried. */
const LINK_APPS = { vaqt: "Vaqt Banki", hisob: "Hisob", momin: "Mo'min" };
function parseCode(code) {
  try {
    const u = new URL(String(code || "").trim());
    const key = decodeURIComponent(u.hash.slice(1));
    if (!/^https?:$/.test(u.protocol) || !/^[a-z]{2,6}_[0-9a-f]{20,64}$/.test(key)) return null;
    if (u.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return null;
    return { url: u.origin, key };
  } catch (e) { return null; }
}
async function linksOf(userId) {
  const { rows } = await pool.query("SELECT links FROM users WHERE id = $1", [userId]);
  return (rows[0] && rows[0].links) || {};
}
async function setLink(userId, app, code) {
  if (!LINK_APPS[app]) throw Object.assign(new Error("Noma'lum ilova."), { status: 400 });
  let val = null;
  if (code) {
    const c = parseCode(code);
    if (!c) throw Object.assign(new Error("Ulanish kodi noto'g'ri. U «https://…/link#…» ko'rinishida bo'ladi."), { status: 400 });
    const want = { vaqt: "vb_", hisob: "hb_", momin: "mo_" }[app];
    if (!c.key.startsWith(want)) throw Object.assign(new Error(`Bu ${LINK_APPS[app]} kaliti emas: u «${want}» bilan boshlanadi.`), { status: 400 });
    const r = await fetch(c.url + "/api/ext/summary", { headers: { "X-Link-Key": c.key }, signal: AbortSignal.timeout(60000) }).catch(e => ({ ok: false, status: 0 }));
    if (!r.ok) throw Object.assign(new Error(r.status === 401 ? `${LINK_APPS[app]} bu kalitni tanimadi. Ilovadan yangisini oling.` : `${LINK_APPS[app]} serveri javob bermadi: manzilni tekshiring yoki bir daqiqadan keyin urining.`), { status: 400 });
    val = { ...c, at: Date.now() };
    if (app === "momin") { const cur = (await linksOf(userId)).momin; if (cur && cur.last) val.last = cur.last; }
  }
  await pool.query("UPDATE users SET links = CASE WHEN $3::jsonb IS NULL THEN links - $2 ELSE jsonb_set(links, ARRAY[$2], $3::jsonb) END WHERE id = $1", [userId, app, val ? JSON.stringify(val) : null]);
  if (app === "vaqt" && val) queueAllSessions(userId).then(() => flushTime(userId)).catch(e => console.error("vaqt queue:", e.message));
  return val;
}
const linkView = l => Object.fromEntries(Object.keys(LINK_APPS).map(a => [a, l[a] && l[a].key ? { url: l[a].url, at: l[a].at || 0, last: l[a].last || 0, err: l[a].err || "", sent: l[a].sent || 0 } : null]));
async function mominToday(l) {
  if (!l.momin || !l.momin.key) return null;
  try { const r = await fetch(l.momin.url + "/api/ext/summary", { headers: { "X-Link-Key": l.momin.key }, signal: AbortSignal.timeout(6000) }); return r.ok ? await r.json() : { err: r.status === 401 ? "kalit eskirgan" : "javob yo'q" }; }
  catch (e) { return { err: "Mo'min serveri javob bermadi" }; }
}
async function linkSummary(x) {
  try { const r = await fetch(x.url + "/api/ext/summary", { headers: { "X-Link-Key": x.key }, signal: AbortSignal.timeout(9000) }); return r.ok ? await r.json() : { err: r.status === 401 ? "kalit eskirgan — qayta ulang" : `javob ${r.status}` }; }
  catch (e) { return { err: "server javob bermadi" }; }
}
app.get("/api/links", auth, wrap(async (req, res) => {
  if (!req.user.api_key) {   // every account has its own ME'MORI key from the start
    await pool.query("UPDATE users SET api_key = $1 WHERE id = $2 AND api_key IS NULL", ["eq_" + crypto.randomBytes(18).toString("hex"), req.user.id]);
    req.user.api_key = (await pool.query("SELECT api_key FROM users WHERE id = $1", [req.user.id])).rows[0].api_key;
  }
  const l = await linksOf(req.user.id);
  const { rows: [q] } = await pool.query("SELECT count(*)::int AS n FROM fwd_out WHERE user_id = $1", [req.user.id]);
  const { rows: [m] } = await pool.query("SELECT count(*) FILTER (WHERE k = 'b')::int AS b, count(*) FILTER (WHERE k = 'i')::int AS i FROM records WHERE user_id = $1 AND data->>'ext' = 'momin' AND NOT (data ? 'del')", [req.user.id]);
  const [today, vaqtLive, hisobLive] = await Promise.all([mominToday(l), l.vaqt && l.vaqt.key ? linkSummary(l.vaqt) : null, l.hisob && l.hisob.key ? linkSummary(l.hisob) : null]);
  res.json({ links: linkView(l), live: { vaqt: vaqtLive, hisob: hisobLive }, waiting: q.n, momin: { sources: m.b, cards: m.i, last: (l.momin && l.momin.last) || 0, today }, key: req.user.api_key || "", base: PUBLIC_URL || "" });
}));
app.post("/api/links", auth, wrap(async (req, res) => {
  try { await setLink(req.user.id, String(req.body.app || ""), req.body.code || null); }
  catch (e) { return fail(res, e.status || 500, e.message); }
  res.json({ links: linkView(await linksOf(req.user.id)) });
}));
// Mo'min passes on the codes it holds, so pairing once in Mo'min is enough.
app.post("/api/ext/links", keyUser, wrap(async (req, res) => {
  const out = {};
  for (const a of ["vaqt", "hisob", "momin"]) {
    if (!(a in (req.body || {}))) continue;
    const cur = (await linksOf(req.user.id))[a], c = req.body[a] ? parseCode(req.body[a]) : null;
    if (req.body[a] && cur && c && cur.key === c.key && cur.url === c.url) { out[a] = "ok"; continue; }
    try { await setLink(req.user.id, a, req.body[a] || null); out[a] = req.body[a] ? "ok" : "off"; } catch (e) { out[a] = e.message; }
  }
  res.json({ ok: true, links: out });
}));

/* forwarding study time to Vaqt Banki */
const KAT = { kitob: "05 Kitob o'qishga", dars: "06 Dars qilishga", sura: "07 Sura yodlashga" };
function katOf(b, s) {
  const t = fold((b && b.title) || "");
  if (/qur'?on|sura|surah|oyat|xatm|yodla/.test(t)) return KAT.sura;
  if (s && s.via === "Takror") return KAT.dars;
  return b && ["badiiy", "ilmiy", "sher", "diniy"].includes(b.kind) ? KAT.kitob : KAT.dars;
}
function timeItem(s, b) {
  const min = Math.round(+s.min || 0);
  if (s.del || !(min > 0)) return { id: "memori-" + s.id, del: 1 };
  const U = { bet: "bet", dars: "dars", daqiqa: "daqiqa" }[s.unit];
  const what = s.via === "Takror" ? "takrorlash" : s.qty && U ? `+${s.qty} ${U}` : "";
  return { id: "memori-" + s.id, sana: s.day, daqiqa: Math.min(1440, min), kat: katOf(b, s), izoh: ["ME'MORI", (b && b.title) || "", what].filter(Boolean).join(" · ").slice(0, 300) };
}
async function queueSessions(userId, sessions) {
  sessions = sessions.filter(s => s && s.k === "s" && !s.demo);
  if (!sessions.length) return;
  const l = await linksOf(userId);
  if (!l.vaqt) return;
  await pool.query(`INSERT INTO fwd_out (user_id, id, at) SELECT $1, x, now() FROM unnest($2::text[]) AS x ON CONFLICT (user_id, id) DO UPDATE SET at = now(), tries = 0`, [userId, sessions.map(s => s.id)]);
  flushSoon(userId);
}
async function queueAllSessions(userId) {
  const { rows } = await pool.query("SELECT data FROM records WHERE user_id = $1 AND k = 's' AND NOT (data ? 'del') AND (data->>'min')::numeric > 0 AND data->>'day' >= $2", [userId, addDay(localNow("Asia/Tashkent").day, -60)]);
  await queueSessions(userId, rows.map(r => r.data));
}
const flushTimers = new Map();
function flushSoon(userId, ms) {
  if (flushTimers.has(userId)) return;
  flushTimers.set(userId, setTimeout(() => { flushTimers.delete(userId); flushTime(userId).catch(e => console.error("vaqt flush:", e.message)); }, ms == null ? 4000 : ms));
}
async function flushTime(userId) {
  const l = await linksOf(userId), v = l.vaqt;
  const { rows: q } = await pool.query("SELECT id FROM fwd_out WHERE user_id = $1 ORDER BY at LIMIT 300", [userId]);
  if (!q.length) return 0;
  if (!v) { await pool.query("DELETE FROM fwd_out WHERE user_id = $1", [userId]); return 0; }
  const ids = q.map(r => r.id);
  const { rows } = await pool.query("SELECT id, data FROM records WHERE user_id = $1 AND id = ANY($2)", [userId, ids]);
  const byId = new Map(rows.map(r => [r.id, r.data]));
  const bids = [...new Set(rows.map(r => r.data.b).filter(Boolean))];
  const { rows: bs } = await pool.query("SELECT id, data FROM records WHERE user_id = $1 AND id = ANY($2)", [userId, bids]);
  const src = new Map(bs.map(r => [r.id, r.data]));
  const items = ids.map(id => { const s = byId.get(id); return s ? timeItem(s, src.get(s.b)) : { id: "memori-" + id, del: 1 }; });
  let err = "";
  try {
    const r = await fetch(v.url + "/api/ext/time", { method: "POST", headers: { "Content-Type": "application/json", "X-Link-Key": v.key }, body: JSON.stringify({ items }), signal: AbortSignal.timeout(70000) });
    if (r.status === 401) err = "Vaqt Banki kodni rad etdi — qayta ulang.";
    else if (!r.ok) err = `Vaqt Banki javobi: ${r.status}`;
  } catch (e) { err = "Vaqt Banki serveriga yetib bo'lmadi."; }
  if (err) {
    await pool.query("UPDATE fwd_out SET tries = tries + 1 WHERE user_id = $1 AND id = ANY($2)", [userId, ids]);
    await pool.query("UPDATE users SET links = jsonb_set(links, '{vaqt,err}', to_jsonb($2::text)) WHERE id = $1 AND links ? 'vaqt'", [userId, err]);
    return -1;
  }
  await pool.query("DELETE FROM fwd_out WHERE user_id = $1 AND id = ANY($2)", [userId, ids]);
  await pool.query("UPDATE users SET links = jsonb_set(jsonb_set(jsonb_set(links, '{vaqt,err}', '\"\"'), '{vaqt,last}', to_jsonb($2::bigint)), '{vaqt,sent}', to_jsonb(COALESCE((links #>> '{vaqt,sent}')::int, 0) + $3)) WHERE id = $1 AND links ? 'vaqt'", [userId, Date.now(), items.length]);
  if (q.length === 300) flushSoon(userId, 500);
  return items.length;
}
// retry what is waiting, every 10 minutes
setInterval(async () => {
  try { const { rows } = await pool.query("SELECT DISTINCT user_id FROM fwd_out WHERE tries < 200"); for (const r of rows) await flushTime(r.user_id).catch(() => {}); } catch (e) {}
}, 10 * 60 * 1000).unref();

/* Mo'min's learning sections, mirrored as sources and cards.
   Body: { app: "momin", full: true, sources: [{ key, title, kind, author, pages, cur, status, cards: [{ key, q, a, r }] }],
           sessions: [{ key, src, day, qty, unit, min }] }
   The ids are derived from the keys, so sending the same thing twice changes nothing. Review state stays here.
   A card that disappears from Mo'min is paused (it keeps its history) — or removed, if it was never reviewed.
   What the person deleted here on purpose stays deleted. New cards come at most NEW_PER_DAY a day. */
const NEW_PER_DAY = 15;
const hid = (...p) => "mm" + crypto.createHash("sha1").update(p.join("\u0001")).digest("hex").slice(0, 18);
const clipS = (s, n) => String(s == null ? "" : s).replace(/\u0000/g, "").slice(0, n);
async function saveMany(userId, list) {
  for (let k = 0; k < list.length; k += 400) {
    const part = list.slice(k, k + 400);
    await pool.query(`
      INSERT INTO records (user_id, id, k, u, data)
      SELECT $1, x.id, x.k, x.u, x.d::jsonb FROM unnest($2::text[], $3::text[], $4::bigint[], $5::text[]) AS x(id, k, u, d)
      ON CONFLICT (user_id, id) DO UPDATE SET k = EXCLUDED.k, u = EXCLUDED.u, data = EXCLUDED.data, rev = nextval('rec_rev')
      WHERE records.u < EXCLUDED.u`, [userId, part.map(r => r.id), part.map(r => r.k), part.map(r => r.u), part.map(r => JSON.stringify(r))]);
  }
}
app.post("/api/ext/mirror", keyUser, wrap(async (req, res) => {
  const body = req.body || {}, appId = /^[a-z]{2,12}$/.test(body.app) ? body.app : "momin", via = LINK_APPS[appId] || appId;
  const inSrc = (Array.isArray(body.sources) ? body.sources : []).slice(0, 300);
  const uid = req.user.id, day = localNow("Asia/Tashkent").day, tomorrow = addDay(day, 1);
  const { rows } = await pool.query("SELECT data FROM records WHERE user_id = $1 AND data->>'ext' = $2", [uid, appId]);
  const old = new Map(rows.map(r => [r.data.id, r.data]));
  let now = Date.now();
  for (const r of old.values()) now = Math.max(now, (r.u || 0) + 1);
  const out = [], seen = new Set(), stat = { sources: 0, cards: 0, newCards: 0, sessions: 0, paused: 0 };
  const load = new Map();   // day → new mirrored cards already waiting for that day
  for (const r of old.values()) if (r.k === "i" && !r.del && !r.n && r.d >= tomorrow) load.set(r.d, (load.get(r.d) || 0) + 1);
  const nextNewDay = () => { let d = tomorrow; while ((load.get(d) || 0) >= NEW_PER_DAY) d = addDay(d, 1); load.set(d, (load.get(d) || 0) + 1); return d; };
  const userGone = r => r && r.del && !r.gone;          // deleted here by the person: leave it alone
  const live = r => { const x = { ...r }; delete x.del; delete x.gone; return x; };
  let c = now;
  for (const s of inSrc) {
    if (!s || !s.key || !s.title) continue;
    const id = hid(appId, "b", s.key), o = old.get(id);
    seen.add(id);
    if (userGone(o)) continue;
    const kind = ["badiiy", "ilmiy", "sher", "diniy", "kurs", "til", "video", "podkast"].includes(s.kind) ? s.kind : "ilmiy";
    const want = { title: clipS(s.title, 160), author: clipS(s.author, 120), kind, pages: Math.max(0, Math.round(+s.pages || 0)), status: s.status === "done" ? "done" : "reading" };
    if (s.cur != null) want.cur = Math.max(0, Math.round(+s.cur || 0));
    if (!o) out.push({ id, k: "b", ...want, cur: want.cur || 0, c: c++, fin: want.status === "done" ? now : 0, ext: appId, xk: clipS(s.key, 120), via, u: now });
    else if (o.gone || Object.keys(want).some(k => o[k] !== want[k])) out.push({ ...live(o), ...want, fin: want.status === "done" ? (o.fin || now) : 0, u: now });
    stat.sources++;
    for (const cd of (Array.isArray(s.cards) ? s.cards : []).slice(0, 5000)) {
      if (!cd || !cd.key || !(cd.q || cd.a)) continue;
      const cid = hid(appId, "i", s.key, cd.key), co = old.get(cid);
      seen.add(cid);
      if (userGone(co)) continue;
      const q = clipS(cd.q, 1000), a = clipS(cd.a, 4000), r = clipS(cd.r || via, 200);
      stat.cards++;
      if (!co) { out.push({ id: cid, k: "i", b: id, t: "card", q, a, r, f: 0, e: 0, c: c++, s: 0, d: nextNewDay(), n: 0, l: 0, h: [], ext: appId, via, u: now }); stat.newCards++; }
      else if (co.gone || co.q !== q || co.a !== a || co.r !== r || co.b !== id) { const x = { ...live(co), q, a, r, b: id, u: now }; if (co.gone && co.off === 1) delete x.off; out.push(x); }
    }
  }
  for (const x of (Array.isArray(body.sessions) ? body.sessions : []).slice(0, 3000)) {
    if (!x || !x.key || !x.src || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.day))) continue;
    const id = hid(appId, "s", x.key), o = old.get(id), b = hid(appId, "b", x.src);
    seen.add(id);
    if (userGone(o) || userGone(old.get(b))) continue;
    const want = { b, day: x.day, qty: Math.max(0, Math.round(+x.qty || 0)), unit: ["bet", "dars", "daqiqa"].includes(x.unit) ? x.unit : "", min: Math.max(0, Math.min(1440, Math.round(+x.min || 0))), from: Math.max(0, Math.round(+x.from || 0)), to: Math.max(0, Math.round(+x.to || 0)) };
    stat.sessions++;
    if (!o) out.push({ id, k: "s", ...want, c: c++, ext: appId, via, u: now });
    else if (o.gone || Object.keys(want).some(k => o[k] !== want[k])) out.push({ ...live(o), ...want, u: now });
  }
  if (body.full) for (const o of old.values()) {
    if (seen.has(o.id) || o.del) continue;
    if (o.k === "i" && (o.h || []).length) { if (o.off !== 1 || !o.gone) { out.push({ ...o, off: 1, gone: 1, u: now }); stat.paused++; } }
    else if (o.k === "b" && [...old.values()].some(i => i.k === "i" && i.b === o.id && (i.h || []).length)) { if (!o.gone) out.push({ ...o, status: "done", gone: 1, u: now }); }
    else out.push({ ...o, del: 1, gone: 1, u: now });
  }
  await saveMany(uid, out);
  await pool.query("UPDATE users SET links = links || jsonb_build_object($2::text, COALESCE(links->$2, '{}'::jsonb) || jsonb_build_object('last', $3::bigint)) WHERE id = $1", [uid, appId, Date.now()]);
  await queueSessions(uid, out.filter(r => r.k === "s"));
  res.json({ ok: true, changed: out.length, ...stat, perDay: NEW_PER_DAY });
}));
app.get("/link", (req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(__dirname, "public", "link.html")); });

/* ── Telegram bot: write from the chat, get reminders and a weekly backup ── */
const TG_SECRET = crypto.createHash("sha256").update(JWT_SECRET + ":tg").digest("hex").slice(0, 32);
let tgBot = "";
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error((j && j.description) || `telegram ${r.status}`);
  return j.result;
}
const say = (chat, text) => tg("sendMessage", { chat_id: chat, text, disable_web_page_preview: true }).catch(e => console.error("tg send:", e.message));
async function tgFile(fileId) {
  const f = await tg("getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.file_path}`);
  return Buffer.from(await r.arrayBuffer());
}
async function tgDoc(chat, buf, name, mime, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  if (caption) fd.append("caption", caption.slice(0, 1000));
  fd.append("document", new Blob([buf], { type: mime }), name);
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: "POST", body: fd });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error((j && j.description) || "sendDocument");
}
// The daily report: today's summary and everything learned so far, as Word and PDF.
async function sendReport(userId, chat) {
  const { buildReport } = require("./report");
  const { rows } = await pool.query("SELECT data FROM records WHERE user_id = $1 AND k = ANY($2) AND NOT (data ? 'del') AND NOT (data ? 'demo')", [userId, ["b", "i", "s", "n"]]);
  const L = await ledger(userId), day = L.day;
  const r = await buildReport(rows.map(x => x.data), L, day);
  const today = rows.filter(x => x.data.k === "i" && !x.data.rev && new Date((x.data.c || 0) + 5 * 3600e3).toISOString().slice(0, 10) === day).length;
  await tgDoc(chat, r.docx, r.name + ".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    `${APP()} · ${day} hisoboti\nXotira balansi: ${L.xotir} XOTIR · bugun ${today} ta yangi yozuv${L.due ? ` · ${L.due} ta takror kutmoqda` : ""}`);
  await tgDoc(chat, r.pdf, r.name + ".pdf", "application/pdf", "Shu hisobotning PDF nusxasi.");
  await pool.query("UPDATE tg_links SET docs_day = $2 WHERE user_id = $1", [userId, day]);
  return { day, bytes: r.docx.length + r.pdf.length };
}
async function sendBackup(userId, chat) {
  const data = await backupOf(userId), n = Object.values(data.recs).filter(r => r.k === "i").length;
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("caption", `${APP()} zaxirasi: ${n} ta yozuv, ${Object.values(data.recs).filter(r => r.k === "b").length} ta manba. Ilovada Sozlamalar → «Zaxiradan tiklash» bilan qayta tiklanadi.`);
  fd.append("document", new Blob([JSON.stringify(data)], { type: "application/json" }), `memori-${new Date().toISOString().slice(0, 10)}.json`);
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: "POST", body: fd });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error((j && j.description) || "sendDocument");
  await pool.query("UPDATE tg_links SET last_backup = now() WHERE user_id = $1", [userId]);
  return n;
}
const HELP = `Menga o'rganganingizni yozing, hisobingizga tushadi.

Namunalar:
• O'tkan kunlar 40-65 bet: Otabek Marg'ilonga keldi
• Atomic Habits 30 bet 25 daq: odat 1% yaxshilanishdan boshlanadi
• Ingliz tili 2 dars
• Python kursi 45 daqiqa

Manba nomi ilovadagidek boshida yoziladi. Topilmasa, «Telegram yozuvlari»ga tushadi.
Kitob sahifasini rasmga olib yuborsangiz, undan kartochkalar tuzaman (izohga manba nomini yozing).

/bugun — bugungi takror va oy hisobi
/manbalar — manbalar ro'yxati
/hisobot — hozir Word va PDF hisobot
/hisobot_soat 21 — kundalik hisobot soati (/hisobot_off — o'chirish)
/zaxira — hozir zaxira fayli
/soat 7 — takror eslatmasi soati`;
async function onTelegram(msg) {
  const chat = msg.chat && msg.chat.id, text = String(msg.text || msg.caption || "").trim();
  if (!chat) return;
  const start = /^\/start(?:\s+(\S+))?/.exec(text);
  if (start && start[1]) {
    const { rows } = await pool.query("DELETE FROM tg_codes WHERE code = $1 AND exp > now() RETURNING user_id", [start[1]]);
    if (!rows[0]) return say(chat, "Bu havola eskirgan. Ilovada Sozlamalar → Telegram → «Ulash»ni qayta bosing.");
    const name = [msg.from && msg.from.first_name, msg.from && msg.from.username ? "@" + msg.from.username : ""].filter(Boolean).join(" ");
    await pool.query("DELETE FROM tg_links WHERE chat_id = $1", [chat]);
    await pool.query("INSERT INTO tg_links (user_id, chat_id, name) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, name = EXCLUDED.name", [rows[0].user_id, chat, name.slice(0, 80)]);
    return say(chat, `Ulandi ✅\n\n${HELP}`);
  }
  const { rows: [link] } = await pool.query("SELECT * FROM tg_links WHERE chat_id = $1", [chat]);
  if (!link) return say(chat, "Avval hisobingizni ulang: ME'MORI ilovasida Sozlamalar → Telegram → «Ulash».");
  const uid = link.user_id;
  if (/^\/(start|yordam|help)\b/.test(text)) return say(chat, HELP);
  if (/^\/bugun\b/.test(text)) { const L = await ledger(uid); return say(chat, `Xotira balansi: ${L.xotir} XOTIR${L.all.pending ? ` (yana ${L.all.pending} ta yozuv birinchi takrorni kutmoqda)` : ""}\nBugun ${L.due} ta takror bor.${L.due ? " Takrorlamasangiz, balans kamayib boradi." : ""}\n\n${ledgerText(L.month, "Shu oy:")}`); }
  if (/^\/manbalar\b/.test(text)) { const bs = (await recordsOf(uid, ["b"])).filter(b => b.status !== "done"); return say(chat, bs.length ? "O'rganilayotgan manbalar:\n" + bs.map(b => "• " + b.title).join("\n") : "Hali manba yo'q."); }
  if (/^\/hisobot_soat\s+\d/.test(text)) { const h = Math.min(23, +/\d{1,2}/.exec(text)[0]); await pool.query("UPDATE tg_links SET docs_hour = $1, docs_on = true WHERE user_id = $2", [h, uid]); return say(chat, `Word va PDF hisobot har kuni soat ${String(h).padStart(2, "0")}:00 da keladi.`); }
  if (/^\/hisobot_(off|ochir)\b/.test(text)) { await pool.query("UPDATE tg_links SET docs_on = false WHERE user_id = $1", [uid]); return say(chat, "Kundalik hisobot o'chirildi. Qayta yoqish: /hisobot_soat 21"); }
  if (/^\/hisobot\b/.test(text)) { await tg("sendChatAction", { chat_id: chat, action: "upload_document" }).catch(() => {}); try { await sendReport(uid, chat); } catch (e) { console.error("report:", e.message); say(chat, "Hisobot tayyorlanmadi, birozdan keyin qayta urining."); } return; }
  if (/^\/zaxira\b/.test(text)) { try { await sendBackup(uid, chat); } catch (e) { say(chat, "Zaxira yuborilmadi, birozdan keyin qayta urining."); } return; }
  const hr = /^\/soat\s+(\d{1,2})/.exec(text);
  if (hr) { const h = Math.min(23, +hr[1]); await pool.query("UPDATE tg_links SET hour = $1 WHERE user_id = $2", [h, uid]); return say(chat, `Takror eslatmasi har kuni soat ${String(h).padStart(2, "0")}:00 da keladi.`); }
  if (text.startsWith("/")) return say(chat, HELP);
  if (msg.photo && msg.photo.length) {
    const prov = await aiUserProv(uid);
    if (!prov) return say(chat, "Rasmdan karta tuzish uchun ilovada Sozlamalar → «AI kaliti»ga kalit kiriting.");
    await tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
    try {
      const buf = await tgFile(msg.photo[msg.photo.length - 1].file_id);
      const cards = await aiCards({ image: { mime: "image/jpeg", data: buf.toString("base64") }, title: text }, prov);
      if (!cards.length) return say(chat, "Rasmdan savol tuzib bo'lmadi. Aniqroq suratga olib ko'ring.");
      const sources = await recordsOf(uid, ["b"]), p = parseEntry(text, sources);
      const b = p.src || await sourceFor(uid, text || "Telegram yozuvlari");
      const now = Date.now(), day = localNow("Asia/Tashkent").day;
      await saveRecords(uid, cards.map((c, k) => ({ id: rid(), k: "i", b: b.id, t: "card", q: c.q, a: c.a, r: "Rasmdan", f: 0, e: 0, c: now + k, s: 0, d: addDay(day, 1), n: 0, l: 0, h: [], via: "Telegram rasm", u: now })));
      return say(chat, `«${b.title}»ga ${cards.length} ta kartochka qo'shildi:\n\n${cards.map(c => `• ${c.q} — ${c.a}`).join("\n")}`);
    } catch (e) { console.error("tg photo:", e.message); return say(chat, "Rasmni o'qib bo'lmadi, birozdan keyin qayta urining."); }
  }
  let body = text;
  if (!body && (msg.voice || msg.audio)) {
    const vp = await aiUserProv(uid);
    if (!vp || vp.kind !== "gemini") return say(chat, "Ovozli xabarni matnga aylantirish uchun Gemini kaliti kerak (ilovada Sozlamalar → «AI kaliti», AIza… bilan boshlanadigan). Hozircha matn bilan yozing.");
    try {
      const v = msg.voice || msg.audio, buf = await tgFile(v.file_id);
      body = (await aiAsk("Transcribe this audio verbatim in its own language (usually Uzbek, Latin script). Reply with only the text.", { mime: v.mime_type || "audio/ogg", data: buf.toString("base64") }, false, vp)).trim();
      if (!body) return say(chat, "Ovozni tushunib bo'lmadi. Qayta yozib ko'ring.");
    } catch (e) { console.error("tg voice:", e.message); return say(chat, "Ovozni matnga aylantirib bo'lmadi."); }
  }
  if (!body) return say(chat, HELP);
  const r = await logEntry(uid, { raw: body, via: "Telegram" });
  if (!r) return say(chat, "Hech narsa topilmadi. Namuna: «O'tkan kunlar 40-65 bet: …»");
  return say(chat, `✅ ${r.title}\n${entryLine(r) || "saqlandi"}${msg.voice ? `\n\n«${body.slice(0, 300)}»` : ""}`);
}
app.post("/api/tg/hook/:secret", wrap(async (req, res) => {
  if (!TG_TOKEN || req.params.secret !== TG_SECRET) return fail(res, 403, "no");
  res.json({ ok: true });
  const m = req.body && (req.body.message || req.body.edited_message);
  if (m) onTelegram(m).catch(e => console.error("tg:", e.message));
}));
app.get("/api/tg", auth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT name, hour, last_backup, docs_on, docs_hour, docs_day FROM tg_links WHERE user_id = $1", [req.user.id]);
  const l = rows[0];
  res.json({ configured: !!TG_TOKEN, bot: tgBot, linked: !!l, name: l ? l.name : "", hour: l ? l.hour : 7, lastBackup: l && l.last_backup, docsOn: l ? l.docs_on : true, docsHour: l ? l.docs_hour : 21, docsDay: l ? l.docs_day : "" });
}));
app.post("/api/tg/docs", auth, wrap(async (req, res) => {
  const on = !!req.body.on, hour = Math.min(23, Math.max(0, Math.floor(+req.body.hour)));
  if (!Number.isFinite(hour)) return fail(res, 400, "Soatni tanlang.");
  const { rowCount } = await pool.query("UPDATE tg_links SET docs_on = $2, docs_hour = $3 WHERE user_id = $1", [req.user.id, on, hour]);
  if (!rowCount) return fail(res, 400, "Avval Telegram'ni ulang.");
  res.json({ docsOn: on, docsHour: hour });
}));
app.post("/api/tg/report", auth, wrap(async (req, res) => {
  const { rows: [l] } = await pool.query("SELECT chat_id FROM tg_links WHERE user_id = $1", [req.user.id]);
  if (!l) return fail(res, 400, "Avval Telegram'ni ulang.");
  try { res.json(await sendReport(req.user.id, l.chat_id)); } catch (e) { console.error("report:", e.message); fail(res, 502, "Hisobotni Telegram'ga yuborib bo'lmadi."); }
}));
app.post("/api/tg/code", auth, wrap(async (req, res) => {
  if (!TG_TOKEN || !tgBot) return fail(res, 400, "Telegram bot serverda sozlanmagan (TELEGRAM_BOT_TOKEN).");
  const code = crypto.randomBytes(9).toString("base64url");
  await pool.query("DELETE FROM tg_codes WHERE user_id = $1 OR exp < now()", [req.user.id]);
  await pool.query("INSERT INTO tg_codes (code, user_id, exp) VALUES ($1, $2, now() + interval '30 minutes')", [code, req.user.id]);
  res.json({ url: `https://t.me/${tgBot}?start=${code}` });
}));
app.post("/api/tg/unlink", auth, wrap(async (req, res) => { await pool.query("DELETE FROM tg_links WHERE user_id = $1", [req.user.id]); res.json({ linked: false }); }));
app.post("/api/tg/backup", auth, wrap(async (req, res) => {
  const { rows: [l] } = await pool.query("SELECT chat_id FROM tg_links WHERE user_id = $1", [req.user.id]);
  if (!l) return fail(res, 400, "Avval Telegram'ni ulang.");
  try { res.json({ notes: await sendBackup(req.user.id, l.chat_id) }); } catch (e) { fail(res, 502, "Telegram'ga yuborib bo'lmadi."); }
}));
// Called with the push reminders: a daily review message at the chosen hour and a backup every 7 days.
async function telegramRound() {
  if (!TG_TOKEN) return;
  const { rows } = await pool.query("SELECT * FROM tg_links");
  for (const l of rows) {
    try {
      const now = localNow("Asia/Tashkent");
      if (now.hour >= l.hour && l.last_day !== now.day) {
        await pool.query("UPDATE tg_links SET last_day = $1 WHERE user_id = $2", [now.day, l.user_id]);
        const n = await dueCount(l.user_id, now.day);
        if (n) await say(l.chat_id, `Bugun ${n} ta yozuvni eslash vaqti keldi. Bir necha daqiqa yetadi.${PUBLIC_URL ? `\n${PUBLIC_URL}/#takror` : ""}`);
      }
      if (l.docs_on && now.hour >= l.docs_hour && l.docs_day !== now.day) {
        await pool.query("UPDATE tg_links SET docs_day = $1 WHERE user_id = $2", [now.day, l.user_id]);
        await sendReport(l.user_id, l.chat_id).catch(e => console.error("tg report:", e.message));
      }
      if (!l.last_backup || Date.now() - new Date(l.last_backup).getTime() > 7 * 864e5) await sendBackup(l.user_id, l.chat_id);
    } catch (e) { console.error("tg round:", e.message); }
  }
}
// Without a public address (a local run, another host) the bot asks Telegram for new messages itself.
let tgOffset = 0;
async function pollTelegram() {
  for (;;) {
    try {
      const ups = await tg("getUpdates", { offset: tgOffset, timeout: 50, allowed_updates: ["message", "edited_message"] });
      for (const u of ups) { tgOffset = u.update_id + 1; const m = u.message || u.edited_message; if (m) await onTelegram(m).catch(e => console.error("tg:", e.message)); }
    } catch (e) { console.error("tg poll:", e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}
async function setupTelegram() {
  if (!TG_TOKEN) return;
  try {
    tgBot = (await tg("getMe")).username || "";
    if (PUBLIC_URL) await tg("setWebhook", { url: `${PUBLIC_URL}/api/tg/hook/${TG_SECRET}`, allowed_updates: ["message", "edited_message"] });
    else { await tg("deleteWebhook", {}); pollTelegram(); console.log("Telegram: no PUBLIC_URL, reading messages by polling."); }
  } catch (e) { console.error("telegram setup:", e.message); }
}

/* ── the app itself ── */
app.use("/api", (req, res) => fail(res, 404, "Bunday manzil yo'q."));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) { if (/(index\.html|sw\.js)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); },
}));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => { console.error(err); fail(res, 500, "Serverda xato yuz berdi. Birozdan keyin qayta urining."); });

migrate().then(loadVapid).then(setupTelegram).then(async () => {
  if (S3_ON) {
    try { await ensureBucket(); console.log(`Object storage: files go to bucket ${S3_BUCKET}.`); setTimeout(() => moveFilesToBucket().catch(e => console.error("move:", e.message)), 3000); }
    catch (e) { console.error("Object storage is set but not reachable:", e.message); }
  }
  setInterval(remind, 5 * 60 * 1000);
  setTimeout(remind, 15000);
  app.listen(PORT, () => console.log(`ME'MORI is listening on ${PORT}`));
}).catch(e => { console.error("Database setup failed:", e.message); process.exit(1); });
