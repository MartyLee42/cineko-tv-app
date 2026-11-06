/** Service-worker runtime caches (see vite.config.ts workbox.runtimeCaching). */
export const META_CACHE = "martytv-meta";
export const IMAGE_CACHE = "martytv-images";

/** Drops cached catalog/media responses so the next user on this browser starts clean. */
export async function clearCatalogCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await Promise.all([caches.delete(META_CACHE), caches.delete(IMAGE_CACHE)]);
  } catch {
    // Cache storage can be unavailable (private mode); nothing to clear then.
  }
}
