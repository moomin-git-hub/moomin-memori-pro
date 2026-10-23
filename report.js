// Daily report as Word (.docx) and PDF: today's summary, then everything learned so far, source by source.
// The Telegram bot sends both files every evening (see telegramRound in server.js) and on /hisobot.
const path = require("path");
const PDFDocument = require("pdfkit");
const D = require("docx");

const FONT = path.join(__dirname, "assets", "fonts", "DejaVuSans.ttf");
const FONT_B = path.join(__dirname, "assets", "fonts", "DejaVuSans-Bold.ttf");
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const KIND = { badiiy: "Badiiy kitob", ilmiy: "Ilmiy kitob", sher: "She'riyat", diniy: "Diniy kitob", kurs: "Kurs", video: "Video", til: "Til", podkast: "Podkast", boshqa: "Boshqa" };
const TYPES = { sketch: "Eskiz", recall: "Eslab yozish", gist: "Bir jumla", apply: "Qo'llash", feynman: "Tushuntirish", link: "Bog'lash", card: "Savol", cloze: "Bo'shliq", mnemo: "Eslatkich", quote: "Iqtibos", sum: "Xulosa" };
const IDEA = { fikr: "Fikr", savol: "Savol", goya: "G'oya" };
const GRADE = ["unutdim", "qiynaldim", "esladim", "oson"];
const plain = t => String(t == null ? "" : t).replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/==(.+?)==/g, "$1")
  .replace(/`(.+?)`/g, "$1").replace(/\{[rgbyp]\|(.+?)\}/g, "$1").replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)").replace(/^(# |> )/gm, "").replace(/\u0000/g, "").trim();
const fmtDay = d => { const [y, m, dd] = String(d).split("-").map(Number); return `${dd}-${MONTHS[m - 1]} ${y}`; };
const dayOf = c => new Date((c || 0) + 5 * 3600e3).toISOString().slice(0, 10);
const num = n => Math.round(+n || 0).toLocaleString("ru-RU").replace(/,/g, " ");

/* What goes in: a plain outline, turned into either format below. */
function outline(recs, L, day) {
  const books = recs.filter(r => r.k === "b").sort((a, b) => (a.c || 0) - (b.c || 0));
  const byId = new Map(books.map(b => [b.id, b]));
  const notes = recs.filter(r => r.k === "i" && byId.has(r.b));
  const sessions = recs.filter(r => r.k === "s" && byId.has(r.b));
  const ideas = recs.filter(r => r.k === "n" && byId.has(r.b));
  const out = [];
  const H1 = t => out.push({ h: 1, t }), H2 = t => out.push({ h: 2, t }), P = (t, o) => out.push({ p: t, ...(o || {}) }), KV = (k, v) => out.push({ kv: [k, v] });
  const noteLines = i => {
    const q = plain(i.q), a = plain(i.a);
    return { title: q || (TYPES[i.t] || "Yozuv"), body: a, meta: [TYPES[i.t], i.r && plain(i.r), i.off ? "to'xtatilgan" : ""].filter(Boolean).join(" · ") };
  };
  out.push({ title: `ME'MORI — kundalik hisobot`, sub: fmtDay(day) });

  H1("Bugun");
  const tN = notes.filter(i => !i.rev && dayOf(i.c) === day), tS = sessions.filter(s => s.day === day), tI = ideas.filter(n => dayOf(n.c) === day);
  const tR = notes.flatMap(i => (i.h || []).filter(x => x[0] === day).map(x => x[1]));
  const min = tS.reduce((a, s) => a + (+s.min || 0), 0), bet = tS.filter(s => s.unit === "bet").reduce((a, s) => a + (+s.qty || 0), 0), dars = tS.filter(s => s.unit === "dars").reduce((a, s) => a + (+s.qty || 0), 0);
  KV("Xotira balansi", `${num(L.xotir)} XOTIR`);
  KV("Yangi yozuvlar", `${tN.length} ta`);
  KV("Takror", tR.length ? `${tR.length} ta (${GRADE.map((g, k) => [g, tR.filter(x => x === k).length]).filter(x => x[1]).map(x => `${x[1]} ${x[0]}`).join(", ")})` : "bo'lmadi");
  if (bet || dars) KV("O'qildi", [bet ? `${bet} bet` : "", dars ? `${dars} dars` : ""].filter(Boolean).join(", "));
  if (min) KV("O'rganishga ketgan vaqt", `${Math.floor(min / 60) ? Math.floor(min / 60) + " soat " : ""}${min % 60} daqiqa`);
  KV("Ertaga takrorlanadi", `${notes.filter(i => !i.off && i.d <= nextDay(day)).length} ta`);
  if (tN.length) {
    H2("Bugun yozganlarim");
    for (const i of tN) { const n = noteLines(i); P(n.title, { b: 1, src: byId.get(i.b).title }); if (n.body && n.body !== n.title) P(n.body); }
  }
  if (tI.length) {
    H2("Bugungi fikr va g'oyalar");
    for (const n of tI) P(`${IDEA[n.kind] || "Fikr"}${n.page ? `, ${n.page}-bet` : ""}${n.line ? `, ${n.line}-qator` : ""}: ${plain(n.text)}${n.answer ? `\nJavob: ${plain(n.answer)}` : ""}`, { src: byId.get(n.b).title });
  }

  H1("Butun bilimlarim");
  KV("Jami manbalar", `${books.length} ta (${books.filter(b => b.status === "done").length} tasi tugatilgan)`);
  KV("Jami yozuvlar", `${notes.filter(i => !i.rev).length} ta`);
  KV("Uzoq xotirada", `${notes.filter(i => (i.s || 0) >= 4).length} ta`);
  const order = [...books].sort((a, b) => (a.id === "glossary") - (b.id === "glossary") || (a.status === "done") - (b.status === "done") || (b.c || 0) - (a.c || 0));
  for (const b of order) {
    const its = notes.filter(i => i.b === b.id).sort((x, y) => (x.c || 0) - (y.c || 0)), ids = ideas.filter(n => n.b === b.id);
    if (!its.length && !ids.length) continue;
    H2(b.title);
    P([KIND[b.kind] || "", b.author, b.pages ? `${b.cur || 0}/${b.pages}` : "", b.status === "done" ? "tugatilgan" : "", `${its.length} ta yozuv`].filter(Boolean).join(" · "), { m: 1 });
    if (b.id === "glossary") { for (const i of its) P(`${plain(i.q)} — ${plain(i.a).replace(/\n/g, " ")}`); continue; }
    for (const i of its) { const n = noteLines(i); P(n.title, { b: 1 }); if (n.body && n.body !== n.title) P(n.body); if (n.meta) P(n.meta, { m: 1 }); }
    if (ids.length) { P("Fikr va g'oyalar", { b: 1 }); for (const n of ids) P(`${IDEA[n.kind] || "Fikr"}${n.page ? ` (${n.page}-bet)` : ""}: ${plain(n.text)}${n.answer ? ` — ${plain(n.answer)}` : ""}${n.done ? " ✓" : ""}`); }
  }
  return out;
}
function nextDay(d) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); }

async function toDocx(o) {
  const kids = [];
  const run = (t, opt) => String(t).split("\n").flatMap((line, k) => [new D.TextRun({ text: line, break: k ? 1 : 0, ...(opt || {}) })]);
  for (const x of o) {
    if (x.title) { kids.push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: run(x.title) })); kids.push(new D.Paragraph({ children: run(x.sub, { color: "6B665B" }), spacing: { after: 240 } })); }
    else if (x.h === 1) kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: run(x.t), spacing: { before: 360, after: 120 } }));
    else if (x.h === 2) kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: run(x.t), spacing: { before: 240, after: 80 } }));
    else if (x.kv) kids.push(new D.Paragraph({ children: [new D.TextRun({ text: x.kv[0] + ": ", color: "6B665B" }), new D.TextRun({ text: x.kv[1], bold: true })] }));
    else if (x.p != null) kids.push(new D.Paragraph({ spacing: { after: x.b ? 20 : 100 }, children: [...run(x.p, { bold: !!x.b, color: x.m ? "6B665B" : undefined, size: x.m ? 19 : 22 }), ...(x.src ? [new D.TextRun({ text: `   — ${x.src}`, color: "9A6F1C", size: 19 })] : [])] }));
  }
  const doc = new D.Document({
    creator: "ME'MORI", title: "ME'MORI hisobot",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
      footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ children: ["ME'MORI · ", D.PageNumber.CURRENT], color: "6B665B", size: 16 })] })] }) },
      children: kids }],
  });
  return D.Packer.toBuffer(doc);
}

async function buildReport(recs, L, day) {
  const o = outline(recs, L, day);
  const [docx, pdf] = await Promise.all([toDocx(o), toPdfBuffered(o)]);
  return { docx, pdf, name: `memori-${day}` };
}
function toPdfBuffered(o) {
  return new Promise((resolve, reject) => {
    // bufferPages: the footer can say «page k of n»
    const doc = new PDFDocument({ size: "A4", bufferPages: true, margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: "ME'MORI hisobot", Author: "ME'MORI" } });
    const bufs = []; doc.on("data", b => bufs.push(b)); doc.on("end", () => resolve(Buffer.concat(bufs))); doc.on("error", reject);
    paint(doc, o); doc.end();
  });
}
function paint(doc, o) {
  doc.registerFont("R", FONT); doc.registerFont("B", FONT_B);
  const W = doc.page.width - 112, gold = "#9a6f1c", ink = "#1d1b16", mute = "#6b665b";
  for (const x of o) {
    if (x.title) { doc.font("B").fontSize(22).fillColor(ink).text(x.title); doc.font("R").fontSize(12).fillColor(mute).text(x.sub); doc.moveDown(0.6); doc.moveTo(56, doc.y).lineTo(56 + W, doc.y).strokeColor("#e0d6c2").stroke(); doc.moveDown(0.6); }
    else if (x.h === 1) { if (doc.y > doc.page.height - 160) doc.addPage(); doc.moveDown(0.6); doc.font("B").fontSize(16).fillColor(gold).text(x.t, 56); doc.moveDown(0.3); }
    else if (x.h === 2) { if (doc.y > doc.page.height - 120) doc.addPage(); doc.moveDown(0.5); doc.font("B").fontSize(13).fillColor(ink).text(x.t, 56); doc.moveDown(0.15); }
    else if (x.kv) { doc.font("R").fontSize(11).fillColor(mute).text(x.kv[0] + ":  ", 56, undefined, { continued: true }).font("B").fillColor(ink).text(x.kv[1]); }
    else if (x.p != null) {
      doc.font(x.b ? "B" : "R").fontSize(x.m ? 9.5 : 11).fillColor(x.m ? mute : ink);
      doc.text(x.p + (x.src ? `   — ${x.src}` : ""), 56, undefined, { width: W, paragraphGap: x.b ? 1 : 4 });
    }
  }
  const range = doc.bufferedPageRange();
  for (let k = 0; k < range.count; k++) {
    doc.switchToPage(range.start + k);
    const bm = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font("R").fontSize(8.5).fillColor(mute).text(`ME'MORI · ${k + 1}/${range.count}`, 56, doc.page.height - 36, { width: W, align: "center", lineBreak: false });
    doc.page.margins.bottom = bm;
  }
}
module.exports = { buildReport, outline };
