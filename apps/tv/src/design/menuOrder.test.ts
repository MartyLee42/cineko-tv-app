import { describe, expect, it } from "vitest";
import { KINOZAL_MENU, PROJECTOR_TEXT, railIndicatorTop, RAIL_FIRST, RAIL_PITCH, TERMINAL_MENU, visibleMenu } from "./menuOrder";

describe("visibleMenu", () => {
  it("keeps every tab when the server has video", () => {
    expect(visibleMenu(KINOZAL_MENU, { video: true })).toEqual(KINOZAL_MENU);
  });
  it("drops «Видео» without YouTube, keeping the order", () => {
    for (const list of [KINOZAL_MENU, TERMINAL_MENU, PROJECTOR_TEXT]) {
      const out = visibleMenu(list, { video: false });
      expect(out).not.toContain("video");
      expect(out).toEqual(list.filter((id) => id !== "video"));
    }
  });
  it("places the rail indicator by the shown list", () => {
    const ids = visibleMenu(KINOZAL_MENU, { video: false });
    expect(railIndicatorTop("explore", ids)).toBe(RAIL_FIRST + ids.indexOf("explore") * RAIL_PITCH + 11);
    expect(railIndicatorTop("explore")).toBe(RAIL_FIRST + KINOZAL_MENU.indexOf("explore") * RAIL_PITCH + 11);
  });
});
