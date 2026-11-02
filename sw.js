// foner service worker: phone notifications only. It deliberately doesn't cache anything,
// so the portal always loads fresh from the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { /* show the fallback below */ }
  e.waitUntil(self.registration.showNotification(m.title || "foner", {
    body: m.body || "",
    icon: "icons/icon-192.png",
    tag: m.tag,
    data: { url: m.url || "#/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hash = e.notification.data?.url || "#/";
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (open.length) {
      await open[0].focus();
      open[0].postMessage({ pushUrl: hash });
    } else {
      await self.clients.openWindow(new URL(hash, self.registration.scope).href);
    }
  })());
});
