import { describe, expect, it } from "vitest";
import { DESIGN_SKELETON, DESIGNS } from "@martytv/ui";
import contract from "../../../../packages/contracts/openapi.yaml?raw";
import { FRAMES } from "./context";
import { KINOZAL_MENU, PROJECTOR_ICONS, PROJECTOR_TEXT, TERMINAL_MENU } from "./menuOrder";
import { FLOOR_R, hasLight, menuItems, SKINS, skinOf } from "./registry";

describe("design registry (design → skeleton + skin)", () => {
  it("covers exactly the contract's ProfileSettings.design enum", () => {
    const m = /\n\s+design: \{ type: string, enum: \[([^\]]+)\]/.exec(contract);
    expect(m).not.toBeNull();
    const enumList = m![1]!.split(",").map((s) => s.trim());
    expect(enumList).toEqual(DESIGNS);
    expect(Object.keys(SKINS).sort()).toEqual([...enumList].sort());
  });

  it("maps every design to a skeleton that has a frame, a Details header and a menu", () => {
    for (const d of DESIGNS) {
      const skin = SKINS[d];
      expect(skin.id).toBe(d);
      expect(skin.skeleton).toBe(DESIGN_SKELETON[d]);
      expect(FRAMES[skin.skeleton]).toBeDefined();
      expect(menuItems(d).length).toBeGreaterThan(5);
    }
    expect(SKINS.wireframe.skeleton).toBe("projector");
    expect(SKINS.cyberpunk.skeleton).toBe("terminal");
    expect(SKINS.deco.skeleton).toBe("kinozal");
    expect(SKINS.popart.skeleton).toBe("projector");
    expect(SKINS.constructivism.skeleton).toBe("terminal");
    expect(SKINS.odyssey.skeleton).toBe("projector");
    // Every later design draws its own background layer.
    expect(new Set(DESIGNS.slice(3).map((d) => SKINS[d].background)).size).toBe(DESIGNS.length - 3);
  });

  it("menus follow the skeleton's shared order (new tabs such as «ТВ» appear in every skin)", () => {
    expect(menuItems("deco")).toBe(KINOZAL_MENU);
    expect(menuItems("cyberpunk")).toBe(TERMINAL_MENU);
    expect(menuItems("wireframe")).toEqual([...PROJECTOR_TEXT, ...PROJECTOR_ICONS]);
    for (const d of DESIGNS) expect(menuItems(d)).toContain("home");
  });

  it("keeps old-engine budgets: at most one animated background layer; light only for Кинозал", () => {
    for (const d of DESIGNS) expect(SKINS[d].animatedLayers).toBeLessThanOrEqual(1);
    expect(DESIGNS.filter(hasLight)).toEqual(["kinozal"]);
    // The floor animation scales by 1/R (index.css sw-run keyframe: 1.2821).
    expect(1 / FLOOR_R).toBeCloseTo(1.2821, 3);
  });

  it("unknown values fall back to Кинозал", () => {
    expect(skinOf("vaporwave").id).toBe("kinozal");
  });
});
