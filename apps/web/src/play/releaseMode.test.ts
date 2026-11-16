import { describe, expect, it } from "vitest";
import { canPlayVideoHere, initialReleaseMode, isTvBrowser } from "./releaseMode";

describe("release sheet mode", () => {
  const base = { stored: null, lastWhere: null, desktop: true, canPlayHere: true } as const;

  it("a computer watches here unless told otherwise", () => {
    expect(initialReleaseMode(base)).toBe("here");
    expect(initialReleaseMode({ ...base, lastWhere: "tv" })).toBe("tv");
    expect(initialReleaseMode({ ...base, lastWhere: "here" })).toBe("here");
    expect(initialReleaseMode({ ...base, stored: "tv", lastWhere: "here" })).toBe("tv");
  });

  it("phones keep the TV (they're the remote) unless the switch was set", () => {
    expect(initialReleaseMode({ ...base, desktop: false })).toBe("tv");
    expect(initialReleaseMode({ ...base, desktop: false, lastWhere: "here" })).toBe("tv");
    expect(initialReleaseMode({ ...base, desktop: false, stored: "here" })).toBe("here");
  });

  it("a browser that can't play video goes to the TV", () => {
    expect(initialReleaseMode({ ...base, canPlayHere: false })).toBe("tv");
  });

  it("probes for plain H.264 / AAC", () => {
    expect(canPlayVideoHere({ canPlayType: () => "probably" })).toBe(true);
    expect(canPlayVideoHere({ canPlayType: () => "" })).toBe(false);
    expect(
      canPlayVideoHere({
        canPlayType: () => {
          throw new Error("x");
        },
      }),
    ).toBe(false);
    expect(canPlayVideoHere(null)).toBe(false);
  });

  it("recognises a TV's own browser (it watches here, it isn't a remote)", () => {
    const tvs = [
      // Yandex Browser Lite on an Android TV box
      "Mozilla/5.0 (Linux; Android 9; Build/PPR1.180610.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 YaBrowser/26.9.1.1 (lite) TV Safari/537.36",
      "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36",
      "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager",
      "Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120.4.1 like Chrome/120.0.6099.230 Safari/537.36",
    ];
    for (const ua of tvs) expect(isTvBrowser(ua), ua).toBe(true);
    const others = [
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 11; TX3 Plus Build/RD2A.211001.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Safari/537.36",
    ];
    for (const ua of others) expect(isTvBrowser(ua), ua).toBe(false);
  });
});
