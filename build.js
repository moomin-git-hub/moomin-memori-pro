// Wraps app.html (the same page that runs inside Claude/Canvas) into public/index.html and index.html for the server.
const fs = require("fs");
const path = require("path");

const body = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
const pushJs = fs.existsSync(path.join(__dirname, "push.js"))
  ? fs.readFileSync(path.join(__dirname, "push.js"), "utf8")
  : "";

const head = `<!doctype html>
<html lang="uz" data-skin="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#05060f">
<meta name="description" content="O'rgangan va bilganlaringiz hisobi: kitob, kurs, video va tilni uzoq xotirada saqlash.">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
<script>try{if(localStorage.getItem("esda-qolsin:skin")!=="light")document.documentElement.dataset.skin="dark";else document.documentElement.dataset.skin="light"}catch(e){}</script>
</head>
<body>
`;
const tail = `
<script>
${pushJs}
</script>
<script>if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));</script>
</body>
</html>
`;

const full = head + body + tail;
fs.mkdirSync(path.join(__dirname, "public"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "public/index.html"), full);
fs.writeFileSync(path.join(__dirname, "index.html"), full);
for (const asset of ["manifest.json", "push.js", "sw.js", "icon-192.png", "icon-512.png"]) {
  const src = path.join(__dirname, asset);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(__dirname, "public", asset));
}
console.log("public/index.html and index.html written:", full.length, "bytes");
