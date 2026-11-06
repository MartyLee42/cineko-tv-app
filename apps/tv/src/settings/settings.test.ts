import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ api: {} }));
vi.mock("@noriginmedia/norigin-spatial-navigation", () => ({ pause: () => undefined, resume: () => undefined }));

const { applyPatch, affectsCatalog, DEFAULT_SETTINGS, withDefaults } = await import("../profile/settings");
const { cycle, moveFocus } = await import("./OptionList");
const { claimKeys } = await import("../remote/keyOwner");

describe("profile settings", () => {
  it("fills defaults and ignores unknown values", () => {
    expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS);
    expect(withDefaults({ theme: "light", loading_style: "nope", hide_anime: true } as never)).toMatchObject({ theme: "light", loading_style: "popcorn", hide_anime: true, autoplay_next_episode: true });
    for (const design of ["wireframe", "cyberpunk", "deco"] as const) expect(withDefaults({ design } as never).design).toBe(design);
  });
  it("cozy mode and poster wobble: defaults, values, junk", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ cozy_mode: false, cozy_ambience: "fireplace", cozy_sound: false, poster_wobble: true });
    expect(withDefaults({ cozy_mode: true, cozy_ambience: "rain", cozy_sound: true, poster_wobble: false } as never)).toMatchObject({
      cozy_mode: true,
      cozy_ambience: "rain",
      cozy_sound: true,
      poster_wobble: false,
    });
    expect(withDefaults({ cozy_ambience: "storm", cozy_mode: "yes" } as never)).toMatchObject({ cozy_ambience: "fireplace", cozy_mode: false });
  });
  it("family sharing: opt-in, showing the family on by default", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ share_with_family: false, show_family: true });
    expect(withDefaults({ share_with_family: true, show_family: false } as never)).toMatchObject({ share_with_family: true, show_family: false });
    expect(withDefaults({ share_with_family: "yes", show_family: 0 } as never)).toMatchObject({ share_with_family: false, show_family: true });
  });
  it("the daily curated row: on by default", () => {
    expect(DEFAULT_SETTINGS.show_curated).toBe(true);
    expect(withDefaults({ show_curated: false } as never).show_curated).toBe(false);
    expect(withDefaults({ show_curated: "no" } as never).show_curated).toBe(true);
  });
  it("optimistic patch keeps the other fields", () => {
    expect(applyPatch({ ...DEFAULT_SETTINGS, theme: "dark" }, { loading_style: "film_reel" })).toMatchObject({ theme: "dark", loading_style: "film_reel" });
    expect(applyPatch(undefined, { hide_watched: true }).hide_watched).toBe(true);
  });
  it("catalog-affecting fields trigger a refetch", () => {
    expect(affectsCatalog({ hide_anime: true })).toBe(true);
    expect(affectsCatalog({ hide_watched: false })).toBe(true);
    expect(affectsCatalog({ theme: "dark" })).toBe(false);
  });
});

describe("option list", () => {
  const choices = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
    { value: "c", label: "C" },
  ];
  it("cycles values both ways", () => {
    expect(cycle(choices, "a", 1)).toBe("b");
    expect(cycle(choices, "c", 1)).toBe("a");
    expect(cycle(choices, "a", -1)).toBe("c");
    expect(cycle(choices, "zz", 1)).toBe("a");
  });
  it("moves focus over headers and notes", () => {
    const rows = [
      { kind: "header", key: "h", label: "H" },
      { kind: "choice", key: "x", label: "X", choices, value: "a", onChange: () => undefined },
      { kind: "note", key: "n", label: "N" },
      { kind: "choice", key: "y", label: "Y", choices, value: "a", onChange: () => undefined },
    ] as const;
    expect(moveFocus([...rows], 1, 1)).toBe(3);
    expect(moveFocus([...rows], 3, 1)).toBe(3);
    expect(moveFocus([...rows], 1, -1)).toBe(1);
  });
  it("only the newest key claim acts", () => {
    const a = claimKeys();
    const b = claimKeys();
    expect(a.top).toBe(false);
    expect(b.top).toBe(true);
    b.release();
    expect(a.top).toBe(true);
    a.release();
  });
});
