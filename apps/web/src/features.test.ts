import { describe, expect, it } from "vitest";
import { ALL_FEATURES } from "@martytv/ui";
import { tabAvailable } from "./features";

describe("tabAvailable", () => {
  it("drops «Видео» only when the server has no video", () => {
    expect(tabAvailable("video", ALL_FEATURES)).toBe(true);
    expect(tabAvailable("video", { ...ALL_FEATURES, video: false })).toBe(false);
    expect(tabAvailable("tv", { ...ALL_FEATURES, video: false })).toBe(true);
    expect(tabAvailable(undefined, { ...ALL_FEATURES, video: false })).toBe(true);
  });
});
