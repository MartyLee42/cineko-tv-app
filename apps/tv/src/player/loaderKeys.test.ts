import { describe, expect, it } from "vitest";
import { bindLoaderKeys, loaderKey, type LoaderArrow } from "./loaderKeys";

describe("loader arrows («Лови!»)", () => {
  it("only arrows, only while a loader is bound", () => {
    expect(loaderKey("left")).toBe(false);
    const got: LoaderArrow[] = [];
    const unbind = bindLoaderKeys((k) => got.push(k));
    expect(loaderKey("left")).toBe(true);
    expect(loaderKey("down")).toBe(true);
    // Back / OK / media keys stay the player's.
    expect(loaderKey("back")).toBe(false);
    expect(loaderKey("ok")).toBe(false);
    expect(loaderKey("playpause")).toBe(false);
    expect(got).toEqual(["left", "down"]);
    unbind();
    expect(loaderKey("right")).toBe(false);
  });

  it("an old unbinding doesn't drop a newer loader", () => {
    const a: LoaderArrow[] = [];
    const b: LoaderArrow[] = [];
    const unbindA = bindLoaderKeys((k) => a.push(k));
    const unbindB = bindLoaderKeys((k) => b.push(k));
    unbindA();
    expect(loaderKey("up")).toBe(true);
    expect(b).toEqual(["up"]);
    unbindB();
  });
});
