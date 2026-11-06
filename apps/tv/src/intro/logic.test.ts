import { describe, expect, it } from "vitest";
import { introPref, shouldShowIntro } from "./logic";

const base = { enabled: true, reducedMotion: false, webdriver: false, forced: false };

describe("startup intro", () => {
  it("plays once per start unless turned off, reduced motion or a test browser", () => {
    expect(shouldShowIntro(base)).toBe(true);
    expect(shouldShowIntro({ ...base, enabled: false })).toBe(false);
    expect(shouldShowIntro({ ...base, reducedMotion: true })).toBe(false);
    expect(shouldShowIntro({ ...base, webdriver: true })).toBe(false);
  });
  it("?intro=1 forces it (tests), but the setting still wins", () => {
    expect(shouldShowIntro({ ...base, webdriver: true, forced: true })).toBe(true);
    expect(shouldShowIntro({ ...base, webdriver: true, forced: true, enabled: false })).toBe(false);
  });
  it("is on by default and remembers off", () => {
    expect(introPref.get()).toBe(true);
    introPref.set(false);
    expect(introPref.get()).toBe(false);
    introPref.set(true);
    expect(introPref.get()).toBe(true);
  });
});
