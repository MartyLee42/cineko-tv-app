import { describe, expect, it } from "vitest";
import { detectInstallPlatform, offerInstall } from "./install";

describe("install", () => {
  it("detects platforms", () => {
    expect(detectInstallPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("ios");
    expect(detectInstallPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", 5)).toBe("ios"); // iPadOS
    expect(detectInstallPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
    expect(detectInstallPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("desktop");
  });
  it("offers install only when not installed and something can be shown", () => {
    expect(offerInstall({ installed: false, canPrompt: true, platform: "android" })).toBe(true);
    expect(offerInstall({ installed: false, canPrompt: false, platform: "ios" })).toBe(true);
    expect(offerInstall({ installed: false, canPrompt: false, platform: "desktop" })).toBe(false);
    expect(offerInstall({ installed: true, canPrompt: true, platform: "android" })).toBe(false);
  });
});
