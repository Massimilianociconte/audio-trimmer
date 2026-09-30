// Runs only when the new PWA activates: never interrupt an active audio job.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const names = await caches.keys();
    for (const name of names) {
      if (!/^ffmpeg-wasm(?:-v[12])?$/.test(name)) continue;
      const cache = await caches.open(name);
      // Legacy caches shared a name across an origin. Preserve other apps.
      for (const request of await cache.keys()) {
        if (request.url.startsWith(scope)) await cache.delete(request);
      }
      if ((await cache.keys()).length === 0) await caches.delete(name);
    }
  })().catch(() => {
    // Cache eviction or unavailable storage must not prevent activation.
  }));
});
