import { describe, expect, it } from "vitest";
import { isIPad, tabletRedirect } from "./tablet";

const IPAD_OLD = "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15";
const IPAD_NEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const TIZEN = "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36";

function store() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("tablet", () => {
  it("detects iPads, including the Mac-looking iPadOS UA", () => {
    expect(isIPad(IPAD_OLD, 5)).toBe(true);
    expect(isIPad(IPAD_NEW, 5)).toBe(true);
    expect(isIPad(IPAD_NEW, 0)).toBe(false); // a real Mac
    expect(isIPad(IPAD_NEW, 0, true)).toBe(true); // touch events only
    expect(isIPad(TIZEN, 0)).toBe(false);
  });
  it("sends iPads to the web app unless the TV version was asked for", () => {
    const s = store();
    expect(tabletRedirect({ search: "" }, IPAD_NEW, 5, false, s)).toBe("/?via=tv");
    expect(tabletRedirect({ search: "" }, TIZEN, 0, false, s)).toBeNull();
    expect(tabletRedirect({ search: "?ui=tv" }, IPAD_NEW, 5, false, s)).toBeNull();
    // Remembered for the session.
    expect(tabletRedirect({ search: "" }, IPAD_NEW, 5, false, s)).toBeNull();
  });
});
