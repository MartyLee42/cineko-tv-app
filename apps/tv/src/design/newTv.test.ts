import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";
import { seedNewTvDesign, startDesign } from "./newTv";

function kv(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

/** Runs index.html's first-frame script against a fake storage; returns the <html> class. */
function firstFrame(init: Record<string, string>): string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const root = { className: "", style: { background: "", color: "" } };
  new Function("localStorage", "document", "window", script)(kv(init), { documentElement: root }, {});
  return root.className;
}

describe("a new TV starts in «Каркас»", () => {
  it("picks the cached design, else «Каркас» unpaired, else «Кинозал»", () => {
    expect(startDesign("deco", false)).toBe("deco");
    expect(startDesign("deco", true)).toBe("deco");
    expect(startDesign(null, false)).toBe("wireframe");
    expect(startDesign(null, true)).toBe("kinozal");
  });

  it("remembers «Каркас» only on a fresh, unpaired TV", () => {
    const fresh = kv({});
    seedNewTvDesign(fresh);
    expect(fresh.m.get("martytv.design")).toBe("wireframe");
    const cached = kv({ "martytv.design": "kinozal" });
    seedNewTvDesign(cached);
    expect(cached.m.get("martytv.design")).toBe("kinozal");
    const paired = kv({ "martytv.device_credential": "dev_x" });
    seedNewTvDesign(paired);
    expect(paired.m.has("martytv.design")).toBe(false);
  });

  it("index.html paints the same first frame", () => {
    expect(firstFrame({})).toContain("design-wireframe");
    expect(firstFrame({ "martytv.device_credential": "dev_x" })).toContain("design-kinozal");
    expect(firstFrame({ "martytv.design": "deco" })).toContain("design-deco");
    expect(firstFrame({ "martytv.design": "kinozal", "martytv.device_credential": "dev_x" })).toContain("design-kinozal");
  });
});
