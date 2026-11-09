import { describe, expect, it } from "vitest";
import { canPlayVideoHere, initialReleaseMode } from "./releaseMode";

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
});
