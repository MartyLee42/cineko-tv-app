import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ api: {} }));

const { REGEN_TILE, withRegenTile } = await import("./regen");

const tile = (id: string) => ({ id, kind: "collection", title: id, subtitle: null, emoji: null, image_path: null, collection_id: id, discover: null }) as never;

describe("regenerate tile", () => {
  it("goes first in the collections row", () => {
    const out = withRegenTile(
      [{ id: "moods", kind: "moods", title: "M", tiles: [] } as never, { id: "collections", kind: "collections", title: "C", tiles: [tile("c1")] } as never],
      { title: "Refresh", subtitle: "Once a day" },
      "Collections of the day",
    );
    expect(out.map((s) => s.id)).toEqual(["moods", "collections"]);
    expect(out[1]!.tiles.map((t) => t.id)).toEqual([REGEN_TILE, "c1"]);
  });
  it("adds the row when there are no collections", () => {
    const out = withRegenTile([{ id: "moods", kind: "moods", title: "M", tiles: [tile("m")] } as never], { title: "Refresh", subtitle: null }, "Collections of the day");
    expect(out[0]).toMatchObject({ id: "collections", title: "Collections of the day" });
    expect(out[0]!.tiles[0]).toMatchObject({ id: REGEN_TILE, title: "Refresh" });
  });
});
