# Esda qolsin

O'rgangan va bilganlaringiz hisobi: kitob, kurs, video va tilni ilmiy usullar bilan uzoq xotirada saqlaydigan ilova.

- **Server:** Node.js + Express, `server.js`
- **Baza:** PostgreSQL (Neon)
- **Hosting:** Render (bepul tarif)
- **Ilova:** `app.html`. Xuddi shu sahifa Claude ichida ham ishlaydi. `npm run build` uni `public/index.html` ga o'raydi.

## Fayllar

| Fayl | Vazifasi |
|---|---|
| `server.js` | Server: kirish, sinxron, fayllar, push-eslatmalar |
| `package.json` | Server kutubxonalari |
| `render.yaml` | Render sozlamasi (Blueprint) |
| `app.html` | Ilovaning asl sahifasi. Shu sahifa Claude ichida ham ishlaydi. |
| `build.js` | `app.html` ni `public/index.html` ga o'raydi |
| `public/index.html` | Brauzerga beriladigan tayyor ilova |
| `public/sw.js` | Service worker: offline ishlash, bildirishnomani ko'rsatish va bosilganda ilovani ochish |
| `public/push.js` | Push-eslatmaga obuna bo'lish, o'chirish, sinash |
| `public/manifest.json` | PWA: telefonga ilova qilib o'rnatish |
| `public/icon-192.png`, `public/icon-512.png` | Ilova belgisi |

## Server nima qiladi

| Yo'l | Vazifasi |
|---|---|
| `POST /api/auth/register`, `/login`, `/google`, `/logout` | Email/parol yoki Google bilan kirish. Sessiya 90 kunlik httpOnly cookie'da saqlanadi. |
| `GET /api/me` | Kim kirgan |
| `POST /api/sync` | Yozuvlarni ikki tomonga sinxronlash: kechroq tahrirlangan yozuv yutadi. |
| `POST /api/files`, `GET /api/files/:id`, `DELETE /api/files/:id` | Yozuvlarga biriktirilgan rasm va fayllar. Faqat egasi ko'radi. |
| `GET /api/export` | Hamma yozuvlar JSON ko'rinishida (zaxira) |
| `GET /api/push/key`, `POST /api/push/subscribe`, `/unsubscribe`, `/test` | Takror eslatmasi (web push) |
| `GET /api/cron?key=CRON_KEY` | Eslatmalarni tekshirish va yuborish (tashqi pinger uchun) |
| `GET /api/health` | Render tekshiruvi uchun |

Jadvallar (`users`, `records`, `files`) server birinchi ishga tushganda o'zi yaratiladi.

Fayllar Neon bazasida saqlanadi. Bitta fayl 10 MB gacha, bir foydalanuvchiga jami 300 MB. Telefon kamerasidagi rasmlar yuklashdan oldin 1600 px gacha siqiladi.

## Joylash: Neon + Render

### 1. Neon
1. neon.tech → **New Project** (region: Frankfurt yoki sizga yaqin).
2. **Connection string**ni nusxalang: `postgresql://...neon.tech/neondb?sslmode=require`.

### 2. GitHub
Bu papkani GitHub repo qilib yuklang. Agar Claude allaqachon yuklagan bo'lsa, bu qadamni o'tkazib yuboring.

### 3. Render
1. render.com → **New → Blueprint** → shu repo. Render `render.yaml` ni o'qiydi.
2. So'ralganda `DATABASE_URL` ga Neon connection string'ini qo'ying.
3. `JWT_SECRET` ni Render o'zi yaratadi.
4. **Apply**. Bir necha daqiqadan keyin ilova `https://esda-qolsin.onrender.com` (yoki shunga o'xshash manzilda) ishlaydi.

Blueprint o'rniga **New → Web Service** ham bo'ladi:
- **Build Command:** `npm install`
- **Start Command:** `node server.js`
- **Environment:** `DATABASE_URL`, `JWT_SECRET` (kamida 24 belgili tasodifiy satr), `NODE_ENV=production`

### 4. Google bilan kirish (ixtiyoriy)
1. console.cloud.google.com → APIs & Services → Credentials → **OAuth client ID** → Web application.
2. **Authorized JavaScript origins** ga Render manzilingizni qo'shing, masalan `https://esda-qolsin.onrender.com`.
3. Client ID'ni Render'da `GOOGLE_CLIENT_ID` ga yozing. Hisob ilovasidagi Client ID'ni ham ishlatsa bo'ladi: unga shu manzilni origin sifatida qo'shing.

Google sozlanmasa ham email/parol bilan kirish ishlaydi.

### 5. Takror eslatmasi (push)
1. VAPID kalitlari server birinchi ishga tushganda o'zi yaratiladi va bazada saqlanadi. Hech narsa sozlash shart emas.
2. Ilovada Sozlamalar (⋮) → **Takror eslatmasi** → soatni tanlang → **Yoqish**.
3. Server har 5 daqiqada tekshiradi. Tanlangan soatda takror bo'lsa, «Bugun N ta yozuvni eslash vaqti keldi» bildirishnomasi keladi. Bosilsa, ilova takrorni o'zi ochadi.
4. Render bepul tarifi 15 daqiqa ishlatilmasa serverni uxlatib qo'yadi, shunda eslatma yuborilmaydi. Buning oldini olish uchun:
   - cron-job.org'da bepul vazifa oching;
   - u har 15 daqiqada `https://SIZNING-MANZIL.onrender.com/api/cron?key=CRON_KEY` manzilini ochsin;
   - `CRON_KEY` ni Render → Environment'dan oling.
5. iPhone'da push faqat ilova bosh ekranga qo'shilganda ishlaydi: Safari → Ulashish → «Bosh ekranga».

### 6. Mo'min ilovasiga ulash
Hisob va Vaqt Banki'dagidek, Mo'min (Kun tartibi) ilovasidagi tugmani Render manziliga ulang.

## O'zgartirish va qayta joylash
1. `app.html` ni tahrirlang.
2. `npm run build` ni ishga tushiring.
3. Commit qilib, push qiling. Render o'zi qayta joylaydi.

## Lokal ishga tushirish
```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/esda JWT_SECRET=$(openssl rand -hex 24) node server.js
```

## Bilish kerak
- Render bepul tarifida server 15 daqiqa ishlatilmasa uxlaydi va birinchi ochilish 30–50 soniya oladi.
- Bu vaqtda ilova brauzerdagi nusxa bilan ishlayveradi va server uyg'ongach sinxronlanadi.
- Neon bepul tarifida 0.5 GB joy bor. Matnli yozuvlar uchun bu ko'p yillarga yetadi. Joyni asosan rasmlar egallaydi.
