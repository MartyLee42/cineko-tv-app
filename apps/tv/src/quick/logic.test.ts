import { describe, expect, it } from "vitest";
import { EMPTY_ME, initialPick, patchMediaMe, ratingChange, stepRating } from "@martytv/media-types";
import { isQuickKey, moveLine, quickLines } from "./logic";

const media = (id: string, me?: object) => ({ id, kind: "movie", tmdb_id: 1, title: id, ...(me ? { me } : {}) });

describe("quickLines", () => {
  it("♥, watchlist and the rating always; dismiss / open when offered", () => {
    expect(quickLines({ dismiss: false, open: false })).toEqual(["like", "want", "rate"]);
    expect(quickLines({ dismiss: true, open: true })).toEqual(["like", "want", "rate", "dismiss", "open"]);
  });
  it("▲▼ stop at the ends", () => {
    expect(moveLine(0, -1, 5)).toBe(0);
    expect(moveLine(2, 1, 5)).toBe(3);
    expect(moveLine(4, 1, 5)).toBe(4);
  });
});

describe("isQuickKey", () => {
  it("☰ / Tools / ContextMenu / Info open the popup; OK and arrows don't", () => {
    expect(isQuickKey({ key: "ContextMenu", keyCode: 93 })).toBe(true);
    expect(isQuickKey({ key: "Unidentified", keyCode: 10135 })).toBe(true);
    expect(isQuickKey({ key: "Info", keyCode: 0 })).toBe(true);
    expect(isQuickKey({ key: "", keyCode: 457 })).toBe(true);
    expect(isQuickKey({ key: "Enter", keyCode: 13 })).toBe(false);
    expect(isQuickKey({ key: "ArrowLeft", keyCode: 37 })).toBe(false);
  });
});

describe("rating picker", () => {
  it("◀▶ move between «Без оценки» (0) and 10", () => {
    expect(stepRating(1, -1)).toBe(0);
    expect(stepRating(0, -1)).toBe(0);
    expect(stepRating(9, 1)).toBe(10);
    expect(stepRating(10, 1)).toBe(10);
  });
  it("starts at the saved rating, else 7", () => {
    expect(initialPick(9)).toBe(9);
    expect(initialPick(null)).toBe(7);
    expect(initialPick(undefined)).toBe(7);
  });
  it("OK saves a new value, clears at 0, does nothing when unchanged", () => {
    expect(ratingChange(8, null)).toEqual({ rating: 8 });
    expect(ratingChange(8, 6)).toEqual({ rating: 8 });
    expect(ratingChange(8, 8)).toBeNull();
    expect(ratingChange(0, 8)).toEqual({ rating: null });
    expect(ratingChange(0, null)).toBeNull();
  });
});

describe("patchMediaMe", () => {
  it("patches every copy, nested anywhere, keeping untouched branches", () => {
    const other = media("b", { ...EMPTY_ME, favorite: true });
    const data = { rows: [{ key: "x", items: [media("a"), other] }], cont: [{ media: media("a", { ...EMPTY_ME, rating: 3 }) }], meta: { n: 1 } };
    const out = patchMediaMe(data, "a", { favorite: true });
    expect(out).not.toBe(data);
    expect(out.rows[0]!.items[0]).toMatchObject({ me: { ...EMPTY_ME, favorite: true } });
    expect(out.cont[0]!.media.me).toEqual({ ...EMPTY_ME, rating: 3, favorite: true });
    expect(out.rows[0]!.items[1]).toBe(other);
    expect(out.meta).toBe(data.meta);
  });
  it("returns the same reference when the title isn't there", () => {
    const data = { items: [media("b")], total: 1 };
    expect(patchMediaMe(data, "a", { rating: 5 })).toBe(data);
    expect(patchMediaMe(undefined, "a", { rating: 5 })).toBeUndefined();
  });
});
