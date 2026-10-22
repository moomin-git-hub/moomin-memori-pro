# ME'MORI 2026

O'rgangan va bilganlaringiz hisobi. Kitob, kurs, video va til hayot davomida bir joyda yig'iladi va ilmiy usullar bilan uzoq xotirada saqlanadi.

Hisob birligi **XOTIR**. Hisob ilovasida pul so'mda, Vaqt Banki'da vaqt soatda o'lchanadi. Bu yerda bilim XOTIR'da o'lchanadi, va balans **hozir xotirangizda turgan** bilimni ko'rsatadi. Ilova nomidagi yil o'z-o'zidan almashadi (ME'MORI 2026, ME'MORI 2027…).

- Har bir yozuv yoki karta **10 XOTIR** turadi. U birinchi takrorda eslanganda hisobga tushadi, shungacha «kutilmoqda».
- Keyin u esda qolish ehtimoliga qarab hisoblanadi: `R = (1 + t / 9S)^-1`, bu yerda `t` oxirgi takrordan beri o'tgan kunlar, `S` esa yozuv turgan pog'onaning oralig'i (FSRS egri chizig'i). Takrorlanmagan bilim o'z-o'zidan kamayadi, takrorlansa yana 10 ga chiqadi va keyingi safar sekinroq kamayadi.
- «Unutdim» jarima emas: yozuv qayta eslanguncha 0 turadi.
- Bet, dars va vaqt harakat hisobi: hisobotda ko'rinadi, XOTIR bermaydi.
- Oy hisobida: **O'rgandim** = takrorlarda topilgan XOTIR, **Unutdim** = unutilgan + vaqt bilan eskirgan XOTIR.

Unvonlar hozirgi balansga qarab beriladi: Boshlovchi (0), Havaskor (100), Izlanuvchi (300), Talaba (700), Bilimdon (1 500), Ustoz (3 000), Olim (6 000), Alloma (12 000). Kunlik maqsad (asli 30 XOTIR) Sozlamalarda o'zgartiriladi.

- **Server:** Node.js + Express, `server.js`
- **Baza:** PostgreSQL (Neon)
- **Hosting:** Render (bepul tarif)
- **Ilova:** `app.html`. Xuddi shu sahifa Claude ichida ham ishlaydi. `npm run build` uni `public/index.html` ga o'raydi.

## Yozish oynalari

- Har bir yozish oynasida matnni bezash tugmalari bor: **qalin**, tagiga chizish, belgilash, boshqa shrift, katta sarlavha, iqtibos, 5 ta rang va havola. Matn oddiy belgilar bilan saqlanadi (`**qalin**`, `__tagiga__`, `==belgi==`, `` `shrift` ``, `{r|qizil}`, `[matn](https://…)`, qator boshida `# ` va `> `), takrorda esa bezalgan holda ko'rinadi.
- **Fikrlar daftari**: manba → «Fikr yozish». Kitob o'qiyotganda qaysi bet va qatorda qanday **fikr**, **savol** yoki **g'oya** kelganini yozib qo'yasiz; xohlasangiz, sababchi jumlani ham. Manba sahifasida bet tartibida turadi, «Javobsiz savollar» alohida ajraladi, savolga keyin javob yozib «Javob topildi» deb belgilanadi va bir tugma bilan kartaga aylantiriladi. Fikrlar XOTIR hisobiga kirmaydi.
- Tez yozish va «Bitta karta» oynalarida ham rasm va fayl biriktiriladi.
- Takrorda: ovoz bilan javob berish, «Orqaga» (oxirgi bahoni bekor qilish) va shu joyning o'zida tahrirlash.
- Adashib kiritilgan bet yoki daqiqani «So'nggi amallar», Kundalik yoki manba sahifasidan ochib tuzatish yoki o'chirish mumkin.

## Fayllar

| Fayl | Vazifasi |
|---|---|
| `server.js` | Server: kirish, sinxron, fayllar, push-eslatmalar, Telegram bot, boshqa ilovalar uchun API, rasmdan karta |
| `package.json` | Server kutubxonalari |
| `render.yaml` | Render sozlamasi (Blueprint) |
| `app.html` | Ilovaning asl sahifasi |
| `build.js` | `app.html` ni `public/index.html` ga o'raydi |
| `public/index.html` | Brauzerga beriladigan tayyor ilova |
| `public/sw.js` | Service worker: offline ishlash va bildirishnomalar |
| `public/push.js` | Push-eslatmaga obuna bo'lish, o'chirish, sinash |
| `public/manifest.json` | PWA: telefonga ilova qilib o'rnatish |
| `public/icon-192.png`, `public/icon-512.png` | Ilova belgisi |

## Server nima qiladi

| Yo'l | Vazifasi |
|---|---|
| `POST /api/auth/register`, `/login`, `/google`, `/logout` | Email/parol yoki Google bilan kirish. Sessiya 90 kun saqlanadi. |
| `GET /api/me` | Kim kirgan |
| `POST /api/sync` | Yozuvlarni ikki tomonga sinxronlash. Keyinroq tahrirlangan yozuv yutadi. |
| `POST /api/files`, `GET /api/files/:id`, `DELETE /api/files/:id` | Yozuvlarga biriktirilgan rasm va fayllar. Faqat egasi ko'radi. |
| `GET /api/export` | Hamma yozuvlar JSON ko'rinishida (zaxira) |
| `GET /api/push/key`, `POST /api/push/subscribe`, `/unsubscribe`, `/test` | Takror eslatmasi (web push) |
| `GET /api/cron?key=CRON_KEY` | Eslatmalar va haftalik zaxirani tekshirish (tashqi pinger uchun) |
| `POST /api/ai/cards` | Kitob sahifasi rasmi yoki matndan savol-javob kartochkalari |
| `POST /api/ai/chat` | Sokrat imtihoni va «Xatoni top» o'yini (Gemini yoki Claude) |
| `GET /api/tg`, `POST /api/tg/code`, `/unlink`, `/backup` | Telegram'ni ulash, uzish, zaxira yuborish |
| `POST /api/tg/hook/…` | Telegram'dan keladigan xabarlar (server o'zi ro'yxatdan o'tkazadi) |
| `GET /api/ext/summary?key=…`, `POST /api/ext/log?key=…` | Vaqt Banki va Mo'min uchun |
| `GET /api/health` | Render tekshiruvi uchun |

Jadvallar server birinchi ishga tushganda o'zi yaratiladi.

## Joylash: Neon + Render

### 1. Neon
1. neon.tech → **New Project** (region: Frankfurt yoki sizga yaqin).
2. **Connection string**ni nusxalang: `postgresql://...neon.tech/neondb?sslmode=require`.

### 2. GitHub
Bu papkani GitHub repo qilib yuklang.

### 3. Render
1. render.com → **New → Blueprint** → shu repo. Render `render.yaml` ni o'qiydi.
2. So'ralganda `DATABASE_URL` ga Neon connection string'ini qo'ying.
3. `TELEGRAM_BOT_TOKEN` va `GEMINI_API_KEY` ni hozircha bo'sh qoldirsa ham bo'ladi (pastga qarang).
4. **Apply**. Bir necha daqiqadan keyin ilova `https://memori.onrender.com` (yoki shunga o'xshash manzilda) ishlaydi.

### 4. Google bilan kirish (ixtiyoriy)
1. console.cloud.google.com → APIs & Services → Credentials → **OAuth client ID** → Web application.
2. **Authorized JavaScript origins** ga Render manzilingizni qo'shing.
3. Client ID'ni Render'da `GOOGLE_CLIENT_ID` ga yozing.

### 5. Telegram bot
1. Telegram'da **@BotFather** → `/newbot` → nom bering (masalan «ME'MORI»), username bering (masalan `memori_hisob_bot`).
2. BotFather bergan tokenni Render → Environment → `TELEGRAM_BOT_TOKEN` ga qo'ying. Saqlang, server qayta ishga tushadi.
3. Server botni o'zi ulaydi (webhook). Manzilni Render o'zi beradi. Ochiq manzil bo'lmasa (masalan, kompyuterda ishga tushirilsa), server xabarlarni o'zi so'rab oladi (polling), hech narsa sozlash kerak emas.
4. Ilovada **Sozlamalar → Telegram → «Telegram'ni ulash»** → Telegram ochiladi → **Start**.

Botga nima yozsa bo'ladi:
- `O'tkan kunlar 40-65 bet: Otabek Marg'ilonga keldi` → shu manbaga yozuv, 26 bet.
- `Sapiens 30 bet 25 daq: kognitiv inqilob` → «Sapiens» bo'lmasa, o'zi ochiladi.
- `Python kursi 2 dars`, `Ingliz tili 45 daqiqa`.
- Ovozli xabar → matnga aylanadi va yoziladi (`GEMINI_API_KEY` kerak).
- Kitob sahifasining rasmi, izohda manba nomi → kartochkalar tuziladi (`GEMINI_API_KEY` kerak).
- `/bugun` bugungi takror va XOTIR balansi, `/manbalar` ro'yxat, `/zaxira` zaxira fayli, `/soat 21` eslatma soati.

Bot har kuni tanlangan soatda takror eslatmasini va **har 7 kunda zaxira faylini** yuboradi. Server yopilib qolsa ham bilimlaringiz Telegram'da saqlanib turadi. Fayl ilovada **Sozlamalar → Zaxiradan tiklash** bilan qayta tiklanadi.

### 6. Rasmdan va yozuvlardan karta (sun'iy intellekt)
1. aistudio.google.com → **Get API key**. Bepul tarif shaxsiy foydalanishga yetadi.
2. Kalitni Render'da `GEMINI_API_KEY` ga qo'ying.
3. Shundan keyin ishga tushadi:
   - manba → **Ko'p karta**: «Kitob sahifasi rasmidan» va «Yozuvlarimdan»;
   - **Batafsil yozish**: «Yozganimdan savol tuzib ber»;
   - manba → ⋮: **Sokrat imtihoni** (yozuvlaringiz bo'yicha bittadan savol) va **Xatoni top** o'yini.

Gemini o'rniga Claude ishlatsa ham bo'ladi: `ANTHROPIC_API_KEY` (pullik) qo'yiladi. Ikkalasi bo'lsa, Gemini ishlatiladi.

### 7. Takror eslatmasi (push)
1. VAPID kalitlari server birinchi ishga tushganda o'zi yaratiladi.
2. Ilovada Sozlamalar → **Takror eslatmasi** → soatni tanlang → **Yoqish**.
3. Render bepul tarifi 15 daqiqa ishlatilmasa serverni uxlatib qo'yadi, shunda eslatma ham, Telegram ham kechikadi. Buning oldini olish uchun:
   - cron-job.org'da bepul vazifa oching;
   - u har 15 daqiqada `https://SIZNING-MANZIL.onrender.com/api/cron?key=CRON_KEY` manzilini ochsin;
   - `CRON_KEY` ni Render → Environment'dan oling.
4. iPhone'da push faqat ilova bosh ekranga qo'shilganda ishlaydi.

### 8. Vaqt Banki va Mo'min bilan ulash
Ilovada **Sozlamalar → Boshqa ilovalar bilan ulash → Kalit yaratish**. Shu kalit bilan:

**Mo'min (kun tartibi)** bugungi takror va XOTIR balansini ko'rsatadi:
```js
const r = await fetch("https://memori.onrender.com/api/ext/summary?key=KALIT").then(r => r.json());
// r.due — bugungi takror soni
// r.xotir — hozirgi XOTIR balansi; r.month.kirim / r.month.chiqim — oy davomida topilgan va yo'qotilgan
// r.month.bet, r.month.dars, r.month.min, r.month.notes — oy hisobi
```

**Vaqt Banki** o'qishga ketgan vaqtni yozadi:
```js
await fetch("https://memori.onrender.com/api/ext/log?key=KALIT", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Atomic Habits", minutes: 40, qty: 25, unit: "bet", text: "ixtiyoriy izoh", via: "Vaqt Banki" })
});
```
`title` bo'yicha manba topiladi, topilmasa ochiladi. `unit`: `bet`, `dars` yoki `daqiqa`. Bu kodni Vaqt Banki va Mo'min fayllariga qo'shish kerak.

## O'zgartirish va qayta joylash
1. `app.html` ni tahrirlang.
2. `npm run build` ni ishga tushiring.
3. Commit qilib, push qiling. Render o'zi qayta joylaydi.

## Lokal ishga tushirish
```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/memori JWT_SECRET=$(openssl rand -hex 24) node server.js
```

## Bilish kerak
- Render bepul tarifida server 15 daqiqa ishlatilmasa uxlaydi va birinchi ochilish 30–50 soniya oladi. Bu vaqtda ilova brauzerdagi nusxa bilan ishlayveradi va server uyg'ongach sinxronlanadi.
- Neon bepul tarifida 0.5 GB joy bor. Matnli yozuvlar uchun bu ko'p yillarga yetadi. Joyni asosan rasmlar egallaydi.
- Umr bo'yi saqlash uchun Telegram'ni ulang: har hafta zaxira fayli keladi.
