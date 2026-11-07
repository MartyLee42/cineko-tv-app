import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; body?: unknown }[] = [];
let server: Record<string, unknown> = {};
vi.mock("../api", () => ({
  api: {
    GET: vi.fn(async () => ({ data: { device: server }, response: new Response() })),
    PATCH: vi.fn(async (_p: string, o: { body: unknown }) => {
      calls.push({ method: "PATCH", body: o.body });
      return { data: { device: server }, response: new Response() };
    }),
    POST: vi.fn(),
    PUT: vi.fn(),
  },
  realtime: { reconnectNow: () => undefined },
}));

describe("tvOwn (this TV's own options on the server)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("seeds what the server lacks from local values, then applies the server's", async () => {
    const { tvOwn } = await import("./tvOwn");
    const { saverPref } = await import("../idle/logic");
    const { introPref } = await import("../intro/logic");
    saverPref.set("dvd");
    introPref.set(true);
    server = { startup_intro: false };
    await tvOwn.sync();
    const seed = (calls[0]?.body as { device: Record<string, unknown> }).device;
    expect(seed.screensaver).toBe("dvd");
    expect(seed.startup_intro).toBeUndefined();
    // The server's value wins locally.
    expect(introPref.get()).toBe(false);
    expect(saverPref.get()).toBe("dvd");
  });

  it("applies a phone's change and re-renders listeners", async () => {
    const { tvOwn } = await import("./tvOwn");
    const { saverPref } = await import("../idle/logic");
    const { prebufferPref } = await import("../player/rebuffer");
    server = { screensaver: "off", show_prebuffer: true, ui_sounds: false, startup_intro: true, calm_motion: false, health_report: true, slow_hint: false, speedtest: true };
    let bumps = 0;
    const off = tvOwn.subscribe(() => bumps++);
    await tvOwn.sync();
    off();
    expect(calls).toHaveLength(0); // nothing to seed
    expect(saverPref.get()).toBe("off");
    expect(prebufferPref.get()).toBe(true);
    expect(bumps).toBe(1);
  });

  it("saves a change made here", async () => {
    const { tvOwn } = await import("./tvOwn");
    const { saverPref } = await import("../idle/logic");
    tvOwn.set("screensaver", "sleep");
    expect(saverPref.get()).toBe("sleep");
    await Promise.resolve();
    expect(calls[0]?.body).toEqual({ device: { screensaver: "sleep" } });
  });
});
