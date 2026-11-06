import { describe, expect, it } from "vitest";
import { ageOf, pickCredits, type PersonCredit } from "./person";

const c = (kind: "movie" | "series", date: string | null, id: string): PersonCredit =>
  ({ media: { id, kind, release_date: date }, role: "", crew: false }) as unknown as PersonCredit;

describe("pickCredits", () => {
  const all = [c("movie", "1999-03-31", "a"), c("series", null, "b"), c("movie", "2021-12-22", "c"), c("series", "2008-01-20", "d")];
  it("keeps server (popularity) order and filters by kind", () => {
    expect(pickCredits(all, "all", "popular").map((x) => x.media.id)).toEqual(["a", "b", "c", "d"]);
    expect(pickCredits(all, "series", "popular").map((x) => x.media.id)).toEqual(["b", "d"]);
  });
  it("sorts newest first with undated last", () => {
    expect(pickCredits(all, "all", "newest").map((x) => x.media.id)).toEqual(["c", "d", "a", "b"]);
  });
});

describe("ageOf", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  it("counts whole years", () => {
    expect(ageOf("1964-09-02", null, now)).toBe(62);
    expect(ageOf("1964-11-02", null, now)).toBe(61);
    expect(ageOf("1930-05-31", "2008-09-26", now)).toBe(78);
    expect(ageOf(null, null, now)).toBeNull();
  });
});
