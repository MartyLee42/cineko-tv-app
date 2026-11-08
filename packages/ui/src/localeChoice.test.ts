import { describe, expect, it } from "vitest";
import { createLocaleChoice, type KeyValueStore } from "./localeChoice";
import { LOCALE_KEY, PROFILE_LOCALE_KEY, navigatorLocale, resolveLocale } from "./localeDetect";

function memory(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

describe("resolveLocale", () => {
  it("device choice > profile language > browser language", () => {
    expect(resolveLocale("en", "kk", "ru-RU")).toBe("en");
    expect(resolveLocale(null, "kk", "ru-RU")).toBe("kk");
    expect(resolveLocale(null, null, "ru-RU")).toBe("ru");
    expect(resolveLocale(null, "", "kk-KZ")).toBe("kk");
    expect(resolveLocale("de", "xx", "fr-FR")).toBe("en"); // junk is skipped
  });
  it("reads the browser language", () => {
    expect(navigatorLocale("ru")).toBe("ru");
    expect(navigatorLocale("kk-KZ")).toBe("kk");
    expect(navigatorLocale("en-GB")).toBe("en");
    expect(navigatorLocale("")).toBe("en");
  });
});

describe("createLocaleChoice", () => {
  it("first run on a new browser: the profile's language applies once it loads, and is cached", () => {
    const s = memory();
    const c = createLocaleChoice(s, "ru-RU");
    expect(c.resolved()).toBe("ru"); // before the profile loads: the browser's
    expect(c.setProfile("kk")).toBe("kk");
    expect(s.data[PROFILE_LOCALE_KEY]).toBe("kk");
    expect(s.data[LOCALE_KEY]).toBeUndefined(); // not a choice made here
    // Next start: Kazakh straight away (no flash of Russian).
    expect(createLocaleChoice(s, "ru-RU").resolved()).toBe("kk");
  });
  it("a choice made on this device wins over the profile's", () => {
    const s = memory({ [LOCALE_KEY]: "en" });
    const c = createLocaleChoice(s, "ru-RU");
    expect(c.setProfile("kk")).toBe("en");
    expect(c.device()).toBe("en");
    expect(c.profile()).toBe("kk");
    expect(c.chooseHere("ru")).toBe("ru");
    expect(c.clearHere()).toBe("kk"); // follow the profile again
  });
  it("a profile without a language falls back to the browser and clears the cache", () => {
    const s = memory({ [PROFILE_LOCALE_KEY]: "kk" });
    const c = createLocaleChoice(s, "en-US");
    expect(c.resolved()).toBe("kk");
    expect(c.setProfile("")).toBe("en");
    expect(s.data[PROFILE_LOCALE_KEY]).toBeUndefined();
    expect(c.setProfile(undefined)).toBe("en");
  });
  it("ignores junk in storage", () => {
    const c = createLocaleChoice(memory({ [LOCALE_KEY]: "de", [PROFILE_LOCALE_KEY]: "xx" }), "kk");
    expect(c.device()).toBeNull();
    expect(c.resolved()).toBe("kk");
  });
});
