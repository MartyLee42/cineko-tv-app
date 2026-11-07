// «Демо TV»: /demo_tv opens the TV app (as /tv/?demo=1) in a browser that is
// signed in to the PWA. No pairing: the browser session gets a short-lived
// credential for a hidden demo device (POST /devices/demo, cookie + CSRF).
// The demo stays off the realtime socket (no presence, remote control,
// health reports or speed tests).

/** `?demo=1` in the TV app's URL. */
export function isDemoSearch(search: string): boolean {
  return /(?:^\?|&)demo=1(?:&|$)/.test(search);
}

export const DEMO = typeof location !== "undefined" && isDemoSearch(location.search);

/** Where /demo_tv sends a signed-out visitor (back here after signing in). */
export const DEMO_LOGIN = "/login?next=" + encodeURIComponent("/demo_tv");

export type DemoResult = { kind: "ok"; credential: string } | { kind: "signed_out" } | { kind: "error" };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Asks the PWA session (the browser's cookie) for a demo credential. */
export async function fetchDemoCredential(f: Fetch = (i, o) => fetch(i, o)): Promise<DemoResult> {
  try {
    const s = await f("/api/v1/auth/session", { credentials: "same-origin", cache: "no-store" });
    if (s.status === 401) return { kind: "signed_out" };
    if (!s.ok) return { kind: "error" };
    const csrf = ((await s.json()) as { csrf_token?: string }).csrf_token;
    // A signed-in API token / TV (no CSRF token) is not a browser session.
    if (!csrf) return { kind: "signed_out" };
    const r = await f("/api/v1/devices/demo", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } });
    if (r.status === 401 || r.status === 403) return { kind: "signed_out" };
    if (!r.ok) return { kind: "error" };
    const credential = ((await r.json()) as { credential?: string }).credential;
    return credential ? { kind: "ok", credential } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/**
 * A rejected demo credential is re-requested, but not in a loop: a second
 * rejection within `windowMs` of the last refresh means the session itself
 * is gone (→ sign in).
 */
export function refreshGuard(windowMs = 10_000, now: () => number = Date.now) {
  let last = -Infinity;
  return (): boolean => {
    const t = now();
    if (t - last < windowMs) return false;
    last = t;
    return true;
  };
}
