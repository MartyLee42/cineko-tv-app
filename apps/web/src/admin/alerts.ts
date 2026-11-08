// Admin → «Инциденты»: pure helpers for the incidents list and the Web Push
// opt-in («Уведомления о сбоях»). The service worker side is public/alerts-sw.js.
import type { Schemas } from "@martytv/contracts";

export type Incident = Schemas["Incident"];

/** Open incidents first (newest first), then closed ones (newest first). */
export function splitIncidents(items: Incident[]): { open: Incident[]; closed: Incident[] } {
  const byOpened = (a: Incident, b: Incident) => Date.parse(b.opened_at) - Date.parse(a.opened_at);
  return {
    open: items.filter((x) => !x.closed_at).sort(byOpened),
    closed: items.filter((x) => !!x.closed_at).sort(byOpened),
  };
}

/** Duration parts of an incident (open ones up to now), at least 1 minute. */
export function durationParts(x: Pick<Incident, "opened_at" | "closed_at">, now = Date.now()): { d: number; h: number; m: number } {
  const end = x.closed_at ? Date.parse(x.closed_at) : now;
  const mins = Math.max(1, Math.round((end - Date.parse(x.opened_at)) / 60_000));
  return { d: Math.floor(mins / 1440), h: Math.floor((mins % 1440) / 60), m: mins % 60 };
}

export type PushSupport = "supported" | "unsupported" | "insecure";

/** Whether this browser can get Web Push (needs HTTPS, a service worker and PushManager). */
export function pushSupport(w: { isSecureContext?: boolean; PushManager?: unknown; Notification?: unknown; navigator?: { serviceWorker?: unknown } }): PushSupport {
  if (!w.navigator?.serviceWorker || !w.PushManager || !w.Notification) return "unsupported";
  if (!w.isSecureContext) return "insecure";
  return "supported";
}

/** base64url (the server's VAPID public key) → bytes for applicationServerKey. */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The subscribe request body from a PushSubscription's JSON. */
export function subscriptionBody(json: { endpoint?: string; keys?: Record<string, string> }, locale: string) {
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, locale };
}

/** Whether an existing subscription was made with another server key (must re-subscribe). */
export function keyChanged(existing: ArrayBuffer | null | undefined, serverKey: string): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  const b = base64UrlToBytes(serverKey);
  return a.length !== b.length || a.some((v, i) => v !== b[i]);
}
