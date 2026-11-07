// The TV app's answer to a lazy chunk that is gone (@martytv/ui/chunk-reload):
// TVs run one page for days (update.ts reloads only at a quiet moment), so a
// screen, loader, design or intro scene of their release can be missing from
// the server after a few deploys. A failed import with a newer release out
// reloads the page once, after the hooks (App: the play request to resume)
// have run and «Обновляем приложение…» is up.
//
// Tiny on purpose: retry.ts (main.tsx, before boot) reports through it.
import { createChunkReload, fetchLatestEntry, pageEntry, setChunkFailedHandler } from "@martytv/ui/chunk-reload";

const hooks = new Set<() => void>();

/** Runs right before the reload (persist what to resume, show the notice). Returns the remover. */
export function beforeChunkReload(fn: () => void): () => void {
  hooks.add(fn);
  return () => void hooks.delete(fn);
}

/** The TV app's directory ("/tv/"): its index.html names the current release's entry. */
const appDir = () => location.pathname.replace(/[^/]*$/, "");

/** A failed import (any error; only chunk download failures count): true = the page reloads. */
export const chunkFailed = createChunkReload({
  ownEntry: () => pageEntry(),
  latestEntry: () => fetchLatestEntry(appDir()),
  beforeReload: () => {
    hooks.forEach((h) => {
      try {
        h();
      } catch {
        // the reload matters more
      }
    });
    // Let the notice paint before the page goes.
    return new Promise<void>((r) => setTimeout(r, 200));
  },
});

// @martytv/ui's own chunks (strings, glyphs) report here too.
setChunkFailedHandler(chunkFailed);

/** A chunk promise that reports its failure here (and still rejects). */
export function watched<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    void chunkFailed(e);
    throw e;
  });
}
