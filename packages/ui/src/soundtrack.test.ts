import { describe, expect, it } from "vitest";
import { soundtrackUrl } from "./soundtrack";

describe("soundtrackUrl", () => {
  it("points at Cineko Music with the interface language", () => {
    expect(soundtrackUrl("", "0b6f9d1e-1c2b-4c3d-8e4f-5a6b7c8d9e0f", "kk")).toBe("/music/soundtrack/0b6f9d1e-1c2b-4c3d-8e4f-5a6b7c8d9e0f?lang=kk");
    expect(soundtrackUrl("http://tv.local/", "a b", "en")).toBe("http://tv.local/music/soundtrack/a%20b?lang=en");
  });
});
