import { describe, expect, it } from "vitest";
import { LoaderPick } from "./loaderPick";
import { LOADER_ANIMATIONS, pickSurprise, takeSurprise, upcomingSurprise, type LoaderAnimation, type SurpriseStore } from "./loaderSurprise";

const memStore = (): SurpriseStore & { v: { last: LoaderAnimation | null; next: LoaderAnimation | null } } => {
  const s = {
    v: { last: null as LoaderAnimation | null, next: null as LoaderAnimation | null },
    get: () => ({ ...s.v }),
    set: (x: { last: LoaderAnimation | null; next: LoaderAnimation | null }) => void (s.v = { ...x }),
  };
  return s;
};

/** A deterministic random sequence. */
const seq = (seed = 3) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

describe("«Сюрприз» loading style", () => {
  it("picks any concrete animation except the last one", () => {
    for (let i = 0; i < 50; i++) {
      const r = i / 50;
      const s = pickSurprise("matrix", r);
      expect(s).not.toBe("matrix");
      expect(LOADER_ANIMATIONS).toContain(s);
    }
    expect(pickSurprise(null, 0)).toBe(LOADER_ANIMATIONS[0]);
    expect(pickSurprise(null, 0.9999)).toBe(LOADER_ANIMATIONS[LOADER_ANIMATIONS.length - 1]);
    // A one-item pool still answers.
    expect(pickSurprise("paws", 0.5, ["paws"])).toBe("paws");
  });

  it("never the same twice in a row; the upcoming one is what the next load shows", () => {
    const store = memStore();
    const rnd = seq();
    let prev: LoaderAnimation | null = null;
    for (let i = 0; i < 40; i++) {
      const ahead = upcomingSurprise(store, rnd);
      const got = takeSurprise(store, rnd);
      expect(got).toBe(ahead);
      expect(got).not.toBe(prev);
      expect(store.v.last).toBe(got);
      expect(store.v.next).not.toBe(got);
      prev = got;
    }
  });

  it("resolves once per load attempt; concrete styles pass through", () => {
    const pick = new LoaderPick(memStore(), seq(11));
    const a = pick.resolve("surprise", "load|1");
    expect(pick.resolve("surprise", "load|1")).toBe(a);
    expect(pick.resolve("surprise", "load|1")).toBe(a);
    const b = pick.resolve("surprise", "load|2");
    expect(b).not.toBe(a);
    expect(pick.resolve("film_reel", "load|3")).toBe("film_reel");
    expect(pick.resolve("bogus", "load|3")).toBe("popcorn");
  });
});
