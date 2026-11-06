import { describe, expect, it } from "vitest";
import { curatedCards, curatedNote } from "./curated";

const media = (id: string, completed = false) => ({ id, title: id, me: { completed, favorite: false, progress_percent: null } }) as never;
const item = (over: Record<string, unknown>) => ({ position: 1, rank: null, title: "x", original_title: "x", year: 1960, kind: "movie", note: null, watched: false, media: null, ...over }) as never;

describe("curated cards", () => {
  it("skips titles missing from the catalog and duplicates", () => {
    const r = curatedCards([item({ media: media("a") }), item({}), item({ media: media("a") }), item({ media: media("b") })]);
    expect(r.media.map((m) => m.id)).toEqual(["a", "b"]);
    expect(r.notes).toHaveLength(2);
    expect(r.missing).toBe(1);
  });
  it("a rated (watched) title gets the ✓", () => {
    const r = curatedCards([item({ watched: true, media: media("a") }), item({ media: media("b") })]);
    expect(r.media[0]!.me?.completed).toBe(true);
    expect(r.media[1]!.me?.completed).toBe(false);
  });
  it("note line: rank and note", () => {
    const rank = (n: number) => `№ ${n}`;
    expect(curatedNote(item({ rank: 3, note: "кристалл времени" }), rank)).toBe("№ 3 · кристалл времени");
    expect(curatedNote(item({ note: "неореализм" }), rank)).toBe("неореализм");
    expect(curatedNote(undefined, rank)).toBe("");
  });
});
