import { describe, expect, it } from "vitest";
import { ALL_FEATURES, serverFeatures } from "./serverFeatures";

describe("serverFeatures", () => {
  it("is all on when unknown (old server, not loaded)", () => {
    expect(serverFeatures(undefined)).toEqual(ALL_FEATURES);
    expect(serverFeatures(null)).toEqual(ALL_FEATURES);
    expect(serverFeatures({})).toEqual(ALL_FEATURES);
  });
  it("turns off only what the server says is off", () => {
    expect(serverFeatures({ features: { video: false, music: true, torrents: true } })).toEqual({ video: false, music: true, torrents: true });
    expect(serverFeatures({ features: { music: false } })).toEqual({ video: true, music: false, torrents: true });
  });
});
