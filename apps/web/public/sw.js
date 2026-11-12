// Shows Keelson's alerts and opens the page each one is about. Pushes are Declarative Web Push
// messages: Safari shows `notification` itself; other browsers show it here.

self.addEventListener("push", (event) => {
  const n = event.data?.json()?.notification ?? {};
  event.waitUntil(
    self.registration.showNotification(n.title ?? "Keelson", {
      body: n.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: n.tag,
      lang: n.lang,
      dir: n.dir,
      silent: n.silent === true,
      data: { url: n.navigate ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin);
  // Only this app's pages are opened, whatever the payload says.
  const target = url.origin === self.location.origin ? url.href : self.location.origin;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url === target) ?? windows[0];
      if (open) return open.navigate(target).then((w) => (w ?? open).focus());
      return self.clients.openWindow(target);
    }),
  );
});
