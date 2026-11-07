// A chunk loader that survives a flaky network: three tries a second apart,
// one shared promise while loading, and a fresh start after a final failure.
// Tiny on purpose: main.tsx uses it (via design/looks/registry.ts) before boot.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function retrying<M>(load: () => Promise<M>, tries = 3): () => Promise<M> {
  let p: Promise<M> | null = null;
  const attempt = (n: number): Promise<M> => load().catch((e: unknown) => (n > 1 ? sleep(1000).then(() => attempt(n - 1)) : Promise.reject(e)));
  return () =>
    (p ??= attempt(tries).catch((e: unknown) => {
      p = null;
      throw e;
    }));
}
