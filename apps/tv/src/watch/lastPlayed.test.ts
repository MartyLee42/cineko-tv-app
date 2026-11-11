import { describe, expect, it } from "vitest";
import { RouteMemory } from "../catalog/nav";
import { adoptPlayed, type PlayedRef } from "./lastPlayed";
import { focusEpisodeIndex } from "./resume";

const s2e1: PlayedRef = { season: 2, episode: 1, episode_id: "e21", at: 2_000 };

describe("Details after the player moved on", () => {
  it("follows the episode the player left the series at (S1E10 → S2E1 comes back to season 2)", () => {
    const mem = new RouteMemory();
    // Shown before playback: season 1 chosen, E7's card focused and played.
    expect(adoptPlayed(mem, null, 1_000)).toBeNull();
    mem.set("season", 1);
    mem.set("idx-ep-1", 6);
    mem.set("idx-ep-2", 3);
    mem.set("focusKey", "ep-e17");
    // Back after E7 → … → E10 → S2E1.
    expect(adoptPlayed(mem, s2e1, 3_000)).toEqual(s2e1);
    expect(mem.get("season")).toBe(2);
    expect(mem.get("idx-ep-2")).toBeUndefined();
    expect(mem.get("idx-ep-1")).toBe(6);
    expect(mem.focusKey).toBe("ep-e21");
  });

  it("leaves a first showing, a header focus and an older playback alone", () => {
    const fresh = new RouteMemory();
    expect(adoptPlayed(fresh, s2e1, 3_000)).toBeNull();
    expect(fresh.get("season")).toBeUndefined();

    const mem = new RouteMemory();
    adoptPlayed(mem, null, 1_000);
    mem.set("focusKey", "d-play");
    adoptPlayed(mem, s2e1, 3_000);
    expect(mem.focusKey).toBe("d-play");
    expect(mem.get("season")).toBe(2);

    // Shown again later without new playback: the user's own choices stay.
    mem.set("season", 1);
    expect(adoptPlayed(mem, s2e1, 5_000)).toEqual(s2e1);
    expect(mem.get("season")).toBe(1);
  });

  it("an episode id not known yet: the episodes row, matched by number", () => {
    const mem = new RouteMemory();
    adoptPlayed(mem, null, 1_000);
    mem.set("focusKey", "ep-e110");
    const ref = { season: 2, episode: 1, episode_id: null, at: 2_000 };
    adoptPlayed(mem, ref, 3_000);
    expect(mem.focusKey).toBe("d-episodes");
    const eps = [
      { id: "e21", episode_number: 1 },
      { id: "e22", episode_number: 2 },
    ];
    expect(focusEpisodeIndex(eps, { played: ref, suggestedId: "e22" })).toBe(0);
  });

  it("focus: remembered, then played, then requested, then suggested", () => {
    const eps = [
      { id: "a", episode_number: 1 },
      { id: "b", episode_number: 2 },
      { id: "c", episode_number: 3 },
    ];
    const played = { episode_id: "b", episode: 2 };
    expect(focusEpisodeIndex(eps, { remembered: 2, played, requested: 1, suggestedId: "a" })).toBe(2);
    expect(focusEpisodeIndex(eps, { played, requested: 3, suggestedId: "a" })).toBe(1);
    expect(focusEpisodeIndex(eps, { played: { episode_id: "zz", episode: 9 }, requested: 3 })).toBe(2);
    expect(focusEpisodeIndex(eps, { played: null, suggestedId: "c" })).toBe(2);
  });
});
