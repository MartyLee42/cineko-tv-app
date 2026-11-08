import { describe, expect, it } from "vitest";
import { base64UrlToBytes, durationParts, keyChanged, pushSupport, splitIncidents, subscriptionBody, type Incident } from "./alerts";

const inc = (id: string, opened: string, closed: string | null): Incident => ({
  id,
  kind: "tmdb",
  cause: "",
  detail: "",
  source: "monitor",
  summary: "TMDB недоступен",
  notes: [],
  opened_at: opened,
  closed_at: closed,
  reminders: 0,
});

describe("incidents list", () => {
  it("puts open incidents first, newest first", () => {
    const { open, closed } = splitIncidents([
      inc("a", "2026-11-01T10:00:00Z", "2026-11-01T10:20:00Z"),
      inc("b", "2026-11-07T21:30:00Z", null),
      inc("c", "2026-11-05T10:00:00Z", "2026-11-05T12:00:00Z"),
    ]);
    expect(open.map((x) => x.id)).toEqual(["b"]);
    expect(closed.map((x) => x.id)).toEqual(["c", "a"]);
  });

  it("measures durations, open ones up to now", () => {
    expect(durationParts({ opened_at: "2026-11-07T21:30:00Z", closed_at: "2026-11-07T21:53:00Z" })).toEqual({ d: 0, h: 0, m: 23 });
    expect(durationParts({ opened_at: "2026-11-07T21:30:00Z", closed_at: null }, Date.parse("2026-11-09T00:35:00Z"))).toEqual({ d: 1, h: 3, m: 5 });
    expect(durationParts({ opened_at: "2026-11-07T21:30:00Z", closed_at: "2026-11-07T21:30:10Z" }).m).toBe(1);
  });
});

describe("push opt-in", () => {
  const sw = { navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} };
  it("needs a service worker, PushManager and HTTPS", () => {
    expect(pushSupport({ ...sw, isSecureContext: true })).toBe("supported");
    expect(pushSupport({ ...sw, isSecureContext: false })).toBe("insecure");
    expect(pushSupport({ navigator: {}, isSecureContext: true })).toBe("unsupported");
    expect(pushSupport({ ...sw, PushManager: undefined, isSecureContext: true })).toBe("unsupported");
  });

  it("decodes the VAPID key", () => {
    const k = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const b = base64UrlToBytes(k);
    expect(b.length).toBe(65);
    expect(b[0]).toBe(4);
    expect(keyChanged(b.buffer, k)).toBe(false);
    expect(keyChanged(new Uint8Array(65).buffer, k)).toBe(true);
    expect(keyChanged(null, k)).toBe(false);
  });

  it("builds the subscribe body", () => {
    expect(subscriptionBody({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } }, "kk")).toEqual({
      endpoint: "https://fcm.googleapis.com/x",
      keys: { p256dh: "p", auth: "a" },
      locale: "kk",
    });
    expect(subscriptionBody({ endpoint: "https://x" }, "ru")).toBeNull();
  });
});
