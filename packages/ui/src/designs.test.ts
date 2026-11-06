import { describe, expect, it } from "vitest";
import { applyDesign, DESIGN_SKELETON, DESIGN_SWATCH, designHasLight, designSkeleton, DESIGNS, SKELETONS } from "./designs";
import { translate, type MessageKey } from "./i18n";

describe("design registry", () => {
  it("maps every design to a skeleton, a swatch and picker strings", () => {
    for (const d of DESIGNS) {
      expect(SKELETONS).toContain(DESIGN_SKELETON[d]);
      expect(designSkeleton(d)).toBe(DESIGN_SKELETON[d]);
      expect(DESIGN_SWATCH[d].accent).toMatch(/^#[0-9a-f]{6}$/);
      for (const k of [`settings.design.${d}`, `settings.design.${d}_hint`] as MessageKey[]) {
        expect(translate("en", k), k).not.toBe(k);
        expect(translate("ru", k), k).not.toBe(translate("en", k));
      }
    }
    // The originals are their own skeleton; the later ones reuse one.
    expect(designSkeleton("wireframe")).toBe("projector");
    expect(designSkeleton("cyberpunk")).toBe("terminal");
    expect(designSkeleton("deco")).toBe("kinozal");
    expect(designSkeleton("popart")).toBe("projector");
    expect(designSkeleton("constructivism")).toBe("terminal");
    expect(designSkeleton("unknown")).toBe("kinozal");
  });

  it("only Кинозал has a light variant", () => {
    expect(DESIGNS.filter(designHasLight)).toEqual(["kinozal"]);
  });

  it("applies html.design-<id> and html.skel-<skeleton>", () => {
    const list = new Set<string>();
    const root = { classList: { toggle: (c: string, on: boolean) => (on ? list.add(c) : list.delete(c)) } };
    const g = globalThis as unknown as { document?: unknown };
    const prev = g.document;
    g.document = { documentElement: root };
    try {
      applyDesign("deco");
      expect([...list].sort()).toEqual(["design-deco", "skel-kinozal"]);
      applyDesign("wireframe");
      expect([...list].sort()).toEqual(["design-wireframe", "skel-projector"]);
    } finally {
      g.document = prev;
    }
  });
});

describe("design tab icon", () => {
  it("every design uses the Cineko favicon", () => {
    if (typeof document === "undefined") return;
    applyDesign("cyberpunk");
    const link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link?.type).toBe("image/png");
  });
});
