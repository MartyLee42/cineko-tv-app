import { describe, expect, it } from "vitest";
import type { ProfileSettings } from "@martytv/contracts";
import { applyTvPatch, type TvSettings } from "./queries";
import { deviceClass } from "./deviceClass";

const view = (over: Partial<ProfileSettings>, eff: Partial<ProfileSettings>): TvSettings => ({
  device_id: "d",
  device: { screensaver: "dvd", language: "ru" },
  updated_at: null,
  profiles: [],
  active_profile_id: null,
  profile_id: "p",
  effective: { design: "deco", theme: "dark", min_votes: 100, ...eff } as ProfileSettings,
  overrides: over as ProfileSettings,
  layered_keys: [],
});

describe("applyTvPatch (optimistic TV settings)", () => {
  it("merges and resets the TV's own options", () => {
    const v = applyTvPatch(view({}, {}), { device: { ui_sounds: true }, reset_device: ["screensaver"] });
    expect(v.device).toEqual({ language: "ru", ui_sounds: true });
  });
  it("sets layered keys in the TV layer and the effective view", () => {
    const v = applyTvPatch(view({ theme: "dark" }, {}), { profile_id: "p", profile: { design: "matrix" } as ProfileSettings, reset: ["theme"] });
    expect(v.overrides).toEqual({ design: "matrix" });
    expect(v.effective?.design).toBe("matrix");
    expect(v.effective?.min_votes).toBe(100);
  });
});

describe("deviceClass", () => {
  it("is decided once and stored; Settings can change it", () => {
    const m = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const first = deviceClass.get();
    expect(["desktop", "mobile"]).toContain(first);
    expect(localStorage.getItem("martytv.device_class")).toBe(first);
    let calls = 0;
    const off = deviceClass.subscribe(() => calls++);
    deviceClass.set(first === "mobile" ? "desktop" : "mobile");
    expect(deviceClass.get()).not.toBe(first);
    expect(localStorage.getItem("martytv.device_class")).toBe(deviceClass.get());
    expect(calls).toBe(1);
    off();
  });
});
