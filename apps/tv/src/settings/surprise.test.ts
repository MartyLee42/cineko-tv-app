import { describe, expect, it, vi } from "vitest";
import { effectiveDesign } from "@martytv/ui";

vi.mock("../api", () => ({ api: {} }));

const { DEFAULT_SETTINGS, themeCache, withDefaults } = await import("../profile/settings");

describe("«Сюрприз» on the TV", () => {
  it("settings: defaults, values, junk", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ design_surprise: "off", design_favorites: [] });
    expect(withDefaults({ design_surprise: "week", design_favorites: ["matrix", "deco", "matrix"] } as never)).toMatchObject({
      design_surprise: "week",
      design_favorites: ["deco", "matrix"],
    });
    expect(withDefaults({ design_surprise: "hourly", design_favorites: ["zzz"] } as never)).toMatchObject({ design_surprise: "off", design_favorites: [] });
  });

  it("the start cache shows today's pick, not the one cached yesterday", () => {
    const s = withDefaults({ design: "deco", design_surprise: "day", design_favorites: ["matrix", "popart", "retro80"] } as never);
    themeCache.setDesign("kinozal", s, "p1"); // e.g. what showed yesterday
    expect(themeCache.design()).toBe(effectiveDesign(s, "p1"));
    // Surprise off: the plain cached design.
    themeCache.setDesign("terminal", withDefaults({ design: "terminal" } as never), "p1");
    expect(themeCache.design()).toBe("terminal");
  });
});
