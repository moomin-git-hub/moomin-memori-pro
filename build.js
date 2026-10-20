// Wraps app.html (the same page that runs inside Claude) into public/index.html for the server.
const fs = require("fs");
const body = fs.readFileSync(__dirname + "/app.html", "utf8");
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
<script src="/push.js" defer></script>
<script>if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));</script>
</body>
</html>
`;
fs.writeFileSync(__dirname + "/public/index.html", head + body + tail);
console.log("public/index.html written", (head + body + tail).length, "bytes");
