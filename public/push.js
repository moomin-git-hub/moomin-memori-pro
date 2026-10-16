// Esda qolsin: daily review reminders by web push.
// The app calls window.EsdaPush from its settings; the server sends the reminder at the chosen hour.
(function () {
  "use strict";
  const b64ToBytes = s => {
    const pad = "=".repeat((4 - (s.length % 4)) % 4), raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  };
  async function call(path, body) {
    const r = await fetch(path, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.error) || "Server javob bermadi.");
    return j;
  }
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tashkent"; } catch (e) { return "Asia/Tashkent"; } };
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

  window.EsdaPush = {
    supported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; },
    // Why push cannot work here, in words for the settings screen, or "" when it can.
    blocker() {
      if (ios() && !standalone()) return "iPhone'da eslatma uchun avval ilovani bosh ekranga qo'shing: Ulashish → «Bosh ekranga».";
      if (!this.supported()) return "Bu brauzer push-eslatmalarni qo'llamaydi.";
      if (Notification.permission === "denied") return "Bildirishnomalar brauzer sozlamalarida bloklangan. Ruxsat bering va qayta urining.";
      return "";
    },
    async status() {
      if (!this.supported()) return { on: false };
      const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
      if (!sub) return { on: false };
      try { const s = await call("/api/push/status?endpoint=" + encodeURIComponent(sub.endpoint)); return { on: !!s.on, hour: s.hour }; }
      catch (e) { return { on: false }; }
    },
    async enable(hour) {
      const why = this.blocker();
      if (why) throw new Error(why);
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Bildirishnomaga ruxsat berilmadi.");
      const { key } = await call("/api/push/key");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
      await call("/api/push/subscribe", { sub: sub.toJSON(), hour, tz: tz() });
      return { on: true, hour };
    },
    async disable() {
      const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
      if (sub) { await call("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
      return { on: false };
    },
    async test() { return call("/api/push/test", {}); },
  };
})();
