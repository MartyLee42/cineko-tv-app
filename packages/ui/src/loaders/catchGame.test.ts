import { describe, expect, it } from "vitest";
import { ITEMS_PER_LOAD, itemStep, laneLevel, laneSide, MAX_ITEMS, moveBasket, newGame, spawnGap, SPAWN_MAX_MS, SPAWN_MIN_MS, stepGame, STEP_MS, STEPS, type Game, type Lane } from "./catchGame";

/** Runs the game for `ms` in 100 ms ticks with a fixed basket and progress function. */
function run(g: Game, from: number, ms: number, p: (t: number) => number, basket: (g: Game) => Lane) {
  const events: { kind: string; lane: Lane }[] = [];
  let spawns = 0;
  let maxOnScreen = 0;
  for (let t = from; t <= from + ms; t += 100) {
    const before = g.nextId;
    const r = stepGame(g, t, p(t), basket(g));
    g = r.game;
    spawns += g.nextId - before;
    maxOnScreen = Math.max(maxOnScreen, g.items.length);
    events.push(...r.events);
  }
  return { g, events, spawns, maxOnScreen };
}

describe("«Лови!» game rules", () => {
  it("arrows: ◀▶ choose the side, ▲▼ the level", () => {
    expect(moveBasket(1, "right")).toBe(3);
    expect(moveBasket(3, "up")).toBe(2);
    expect(moveBasket(2, "left")).toBe(0);
    expect(moveBasket(0, "down")).toBe(1);
    expect(moveBasket(0, "left")).toBe(0);
    for (const l of [0, 1, 2, 3] as Lane[]) {
      expect(laneSide(moveBasket(l, "right"))).toBe("right");
      expect(laneLevel(moveBasket(l, "down"))).toBe("bottom");
    }
  });

  it("an item rolls STEPS steps, then is caught when the basket is at its lane", () => {
    const g0: Game = { ...newGame(0), items: [{ id: 1, lane: 2, born: 0 }], budget: 0, lastSpawn: 0, nextId: 10 };
    expect(itemStep(g0.items[0]!, STEP_MS * 2 + 1)).toBe(2);
    const early = stepGame(g0, STEP_MS * (STEPS - 1), 0, 2);
    expect(early.events).toEqual([]);
    const end = stepGame(g0, STEP_MS * STEPS, 0, 2);
    expect(end.events).toEqual([{ kind: "catch", lane: 2 }]);
    expect(end.game.caught).toBe(1);
    expect(end.game.items.find((i) => i.id === 1)).toBeUndefined();
  });

  it("missing drops it with a crack", () => {
    const g0: Game = { ...newGame(0), items: [{ id: 1, lane: 1, born: 0 }], budget: 0, lastSpawn: 0, nextId: 10 };
    const end = stepGame(g0, STEP_MS * STEPS, 0, 3);
    expect(end.events).toEqual([{ kind: "miss", lane: 1 }]);
    expect(end.game.missed).toBe(1);
    expect(end.game.cracks).toEqual([{ lane: 1, at: STEP_MS * STEPS }]);
  });

  it("spawn gaps stay within 0.6–1.5 s, sooner with more progress owed", () => {
    expect(spawnGap(0)).toBe(SPAWN_MAX_MS);
    expect(spawnGap(1.5)).toBeLessThan(SPAWN_MAX_MS);
    expect(spawnGap(10)).toBe(SPAWN_MIN_MS);
  });

  it("items follow progress: a stalled load spawns slowly, a fast one quickly; never more than MAX_ITEMS", () => {
    const stalled = run(newGame(0, 0.3), 0, 30_000, () => 0.3, () => 0);
    const fast = run(newGame(0, 0), 0, 30_000, (t) => Math.min(1, t / 30_000), () => 0);
    // Stalled: about one per SPAWN_MAX_MS.
    expect(stalled.spawns).toBeLessThanOrEqual(Math.ceil(30_000 / SPAWN_MAX_MS) + 1);
    expect(stalled.spawns).toBeGreaterThan(10);
    expect(fast.spawns).toBeGreaterThan(stalled.spawns);
    expect(fast.spawns).toBeLessThanOrEqual(ITEMS_PER_LOAD + 2);
    expect(fast.maxOnScreen).toBeLessThanOrEqual(MAX_ITEMS);
    expect(stalled.maxOnScreen).toBeLessThanOrEqual(MAX_ITEMS);
  });

  it("a basket that follows the oldest item catches everything; a parked one misses some", () => {
    const follow = run(newGame(0, 0, 42), 0, 20_000, (t) => t / 20_000, (g) => g.items[0]?.lane ?? 0);
    expect(follow.g.missed).toBe(0);
    expect(follow.g.caught).toBeGreaterThan(5);
    const parked = run(newGame(0, 0, 42), 0, 20_000, (t) => t / 20_000, () => 0);
    expect(parked.g.missed).toBeGreaterThan(0);
    expect(parked.g.caught + parked.g.missed).toBe(follow.g.caught + follow.g.missed);
  });
});
