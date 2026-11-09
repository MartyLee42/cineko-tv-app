import { describe, expect, it } from "vitest";
import { applyChanges, cellOf, groupByAccount, overrideMap, resetAll, resetLine, toggleCell, toggleLine, type VisProfile, type Visibility } from "./visibility";

const prof = (id: string, user: string, share: boolean): VisProfile => ({
  profile_id: id,
  name: id.toUpperCase(),
  avatar: "",
  color: "#000",
  user_id: user,
  user_name: user,
  share_with_family: share,
  show_family: true,
});

// a, b: account u1 (a shares); c: account u2 (doesn't share).
const base: Visibility = { profiles: [prof("a", "u1", true), prof("b", "u1", false), prof("c", "u2", false)], overrides: [] };
const at = (v: Visibility, viewer: string, sharer: string) => cellOf(overrideMap(v), viewer, v.profiles.find((p) => p.profile_id === sharer)!);

describe("family visibility matrix", () => {
  it("defaults to the sharer's share_with_family", () => {
    expect(at(base, "b", "a")).toEqual({ visible: true, override: null, fallback: true });
    expect(at(base, "a", "c")).toEqual({ visible: false, override: null, fallback: false });
  });

  it("an override wins over the default and a reset clears it", () => {
    let v = applyChanges(base, [toggleCell(base, "c", base.profiles[0]!)]);
    expect(at(v, "c", "a")).toEqual({ visible: false, override: false, fallback: true });
    v = applyChanges(v, [toggleCell(v, "c", v.profiles[0]!)]);
    expect(at(v, "c", "a").override).toBe(true); // explicit even when equal to the default
    v = applyChanges(v, resetAll(v));
    expect(v.overrides).toEqual([]);
  });

  it("groups profiles by account in order", () => {
    expect(groupByAccount(base.profiles).map((g) => [g.userId, g.profiles.map((p) => p.profile_id)])).toEqual([
      ["u1", ["a", "b"]],
      ["u2", ["c"]],
    ]);
  });

  it("toggles a whole row or column, skipping the diagonal", () => {
    const row = toggleLine(base, { viewer: "a" });
    expect(row.map((c) => [c.sharer_profile_id, c.allowed])).toEqual([
      ["b", true],
      ["c", true],
    ]);
    // Column a is already visible to everyone → hide it.
    const col = toggleLine(base, { sharer: "a" });
    expect(col.map((c) => [c.viewer_profile_id, c.allowed])).toEqual([
      ["b", false],
      ["c", false],
    ]);
  });

  it("resets only the line's overrides", () => {
    const v = applyChanges(base, [
      { viewer_profile_id: "b", sharer_profile_id: "c", allowed: true },
      { viewer_profile_id: "a", sharer_profile_id: "c", allowed: true },
      { viewer_profile_id: "c", sharer_profile_id: "a", allowed: false },
    ]);
    expect(resetLine(v, { sharer: "c" }).map((c) => c.viewer_profile_id)).toEqual(["a", "b"]);
    expect(resetLine(v, { viewer: "b" })).toEqual([{ viewer_profile_id: "b", sharer_profile_id: "c", allowed: null }]);
    expect(resetLine(base, { viewer: "a" })).toEqual([]);
  });
});
