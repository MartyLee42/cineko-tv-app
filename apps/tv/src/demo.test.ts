import { describe, expect, it } from "vitest";
import { DEMO_LOGIN, fetchDemoCredential, isDemoSearch, refreshGuard } from "./demo";

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Record<string, { status: number; body?: unknown }>, calls: Call[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[url];
    if (!r) throw new TypeError("network");
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
}

describe("demo mode", () => {
  it("is on only with demo=1 in the query", () => {
    expect(isDemoSearch("?demo=1")).toBe(true);
    expect(isDemoSearch("?x=2&demo=1")).toBe(true);
    expect(isDemoSearch("?demo=1&x=2")).toBe(true);
    expect(isDemoSearch("")).toBe(false);
    expect(isDemoSearch("?demo=0")).toBe(false);
    expect(isDemoSearch("?demo=10")).toBe(false);
    expect(isDemoSearch("?nodemo=1")).toBe(false);
  });

  it("signs in back to /demo_tv", () => {
    expect(DEMO_LOGIN).toBe("/login?next=%2Fdemo_tv");
  });

  it("gets a credential with the session's CSRF token", async () => {
    const calls: Call[] = [];
    const f = fakeFetch(
      {
        "/api/v1/auth/session": { status: 200, body: { csrf_token: "c5rf", user: {} } },
        "/api/v1/devices/demo": { status: 201, body: { credential: "mtd_x", device_id: "d", expires_at: "" } },
      },
      calls,
    );
    expect(await fetchDemoCredential(f)).toEqual({ kind: "ok", credential: "mtd_x" });
    const post = calls[1]!;
    expect(post.init?.method).toBe("POST");
    expect((post.init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("c5rf");
  });

  it("reports a signed-out browser and errors", async () => {
    expect(await fetchDemoCredential(fakeFetch({ "/api/v1/auth/session": { status: 401 } }))).toEqual({ kind: "signed_out" });
    // Not a browser session (no CSRF token).
    expect(await fetchDemoCredential(fakeFetch({ "/api/v1/auth/session": { status: 200, body: {} } }))).toEqual({ kind: "signed_out" });
    expect(
      await fetchDemoCredential(
        fakeFetch({ "/api/v1/auth/session": { status: 200, body: { csrf_token: "c" } }, "/api/v1/devices/demo": { status: 403 } }),
      ),
    ).toEqual({ kind: "signed_out" });
    expect(await fetchDemoCredential(fakeFetch({ "/api/v1/auth/session": { status: 502 } }))).toEqual({ kind: "error" });
    expect(await fetchDemoCredential(fakeFetch({}))).toEqual({ kind: "error" });
  });

  it("re-requests a rejected credential at most once per window", () => {
    let t = 0;
    const ok = refreshGuard(10_000, () => t);
    expect(ok()).toBe(true);
    t = 5_000;
    expect(ok()).toBe(false);
    t = 20_000;
    expect(ok()).toBe(true);
  });
});
