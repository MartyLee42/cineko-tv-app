import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";
import { adoptServerNewTvDesign, seedNewTvDesign, startDesign } from "./newTv";

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
  it("picks the cached design, else «Каркас»", () => {
    expect(startDesign("deco")).toBe("deco");
    expect(startDesign(null)).toBe("wireframe");
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

  it("marks the fresh-TV guess as seeded", () => {
    const fresh = kv({});
    seedNewTvDesign(fresh);
    expect(fresh.m.get("martytv.design_seeded")).toBe("1");
  });

  it("takes the server's design for new TVs only while on the guess", () => {
    const fresh = kv({});
    seedNewTvDesign(fresh);
    expect(adoptServerNewTvDesign("deco", fresh)).toBe(true);
    expect(fresh.m.get("martytv.design")).toBe("deco");
    expect(adoptServerNewTvDesign("deco", fresh)).toBe(false); // nothing changed
    // The default switched off on the server: the plain default.
    expect(adoptServerNewTvDesign("", fresh)).toBe(true);
    expect(fresh.m.get("martytv.design")).toBe("wireframe");
    // A TV that has shown a profile keeps its design.
    const own = kv({ "martytv.design": "noir" });
    expect(adoptServerNewTvDesign("wireframe", own)).toBe(false);
    expect(own.m.get("martytv.design")).toBe("noir");
    // Nothing cached at all (storage wiped while paired): the server's default.
    const wiped = kv({});
    expect(adoptServerNewTvDesign("western", wiped)).toBe(true);
    expect(wiped.m.get("martytv.design")).toBe("western");
    // Older servers say nothing.
    expect(adoptServerNewTvDesign(undefined, kv({}))).toBe(false);
  });

  it("index.html paints the same first frame", () => {
    expect(firstFrame({})).toContain("design-wireframe");
    expect(firstFrame({ "martytv.device_credential": "dev_x" })).toContain("design-wireframe");
    expect(firstFrame({ "martytv.design": "deco" })).toContain("design-deco");
    expect(firstFrame({ "martytv.design": "kinozal", "martytv.device_credential": "dev_x" })).toContain("design-kinozal");
  });
});
