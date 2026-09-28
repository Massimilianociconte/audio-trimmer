/**
 * Pulizia cache PWA + reset duro dell'app.
 * Serve quando un tablet resta inchiodato a un bundle vecchio o a un wasm
 * tronco in cache: svuota precache + cache wasm, deregistra il SW e ricarica
 * con query anti-cache (bypassa il navigateFallback stantio).
 * I progetti IndexedDB NON vengono toccati (solo su conferma esplicita).
 */

export async function hardResetApp({ includeProjects = false } = {}) {
  const errors = [];
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('workbox-precache') || key.includes('ffmpeg-wasm'))
        .map((key) => caches.delete(key).catch(() => false)),
    );
  } catch (error) {
    errors.push(error);
  }
  if (includeProjects) {
    try {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('audio-cutter-db');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
      });
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  } catch (error) {
    errors.push(error);
  }
  try {
    window.location.href = `./?reset=${Date.now()}`;
  } catch (error) {
    errors.push(error);
  }
  return errors;
}
