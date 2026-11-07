// «Лови!»: the waiting game's pure rules. Items (torrent pieces) roll down
// four chutes — top-left, bottom-left, top-right, bottom-right — in LCD
// steps; Cineko's basket sits at one of the four chute ends (the remote's
// arrows move it). Reaching the end: caught when the basket is there, else
// it drops and cracks. New items follow the load's progress (a budget that
// grows with progress deltas), at most one per SPAWN_MIN_MS..SPAWN_MAX_MS
// and MAX_ITEMS at once. Tested in catchGame.test.ts.

/** 0 top-left, 1 bottom-left, 2 top-right, 3 bottom-right. */
export type Lane = 0 | 1 | 2 | 3;

export const LANES: readonly Lane[] = [0, 1, 2, 3];
/** Discrete positions along a chute (LCD segments); the last step is the drop. */
export const STEPS = 5;
export const STEP_MS = 520;
export const MAX_ITEMS = 4;
export const SPAWN_MIN_MS = 600;
export const SPAWN_MAX_MS = 1500;
/** Items per whole load (the budget grows by this × the progress delta). */
export const ITEMS_PER_LOAD = 60;
/** A crack stays on screen this long. */
export const CRACK_MS = 900;

export const laneSide = (l: Lane): "left" | "right" => (l < 2 ? "left" : "right");
export const laneLevel = (l: Lane): "top" | "bottom" => (l % 2 === 0 ? "top" : "bottom");

/** The basket after an arrow: ◀▶ choose the side, ▲▼ the level. */
export function moveBasket(at: Lane, key: "left" | "right" | "up" | "down"): Lane {
  const right = key === "right" ? true : key === "left" ? false : laneSide(at) === "right";
  const bottom = key === "down" ? true : key === "up" ? false : laneLevel(at) === "bottom";
  return ((right ? 2 : 0) + (bottom ? 1 : 0)) as Lane;
}

export interface Item {
  id: number;
  lane: Lane;
  born: number;
}

export interface Crack {
  lane: Lane;
  at: number;
}

export interface Game {
  items: Item[];
  cracks: Crack[];
  caught: number;
  missed: number;
  /** Items owed by progress so far. */
  budget: number;
  lastP: number;
  lastSpawn: number;
  nextId: number;
  seed: number;
}

export type GameEvent = { kind: "catch" | "miss"; lane: Lane };

export function newGame(now: number, p = 0, seed = 1): Game {
  // The first item comes soon (a little budget to start with).
  return { items: [], cracks: [], caught: 0, missed: 0, budget: 1, lastP: p, lastSpawn: now - SPAWN_MAX_MS + 800, nextId: 1, seed: seed >>> 0 || 1 };
}

/** Where an item is along its chute: 0..STEPS-1 while rolling, STEPS when it reaches the end. */
export function itemStep(it: Item, now: number): number {
  return Math.min(STEPS, Math.max(0, Math.floor((now - it.born) / STEP_MS)));
}

function rnd(seed: number): [number, number] {
  const s = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return [s / 4294967296, s];
}

/** How long to wait before the next item: sooner the more progress owes. */
export function spawnGap(budget: number): number {
  if (budget >= 3) return SPAWN_MIN_MS;
  if (budget >= 1) return 1000;
  return SPAWN_MAX_MS;
}

/**
 * Advances the game to `now` with the load's progress `p` and the basket at
 * `basket`: resolves items that reached the end (catch / miss), drops old
 * cracks, spawns new items. Pure (returns a new state and what happened).
 */
export function stepGame(g: Game, now: number, p: number, basket: Lane): { game: Game; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let { caught, missed, seed, nextId, lastSpawn } = g;
  const dp = Math.max(0, p - g.lastP);
  let budget = g.budget + dp * ITEMS_PER_LOAD;
  const items: Item[] = [];
  const cracks = g.cracks.filter((c) => now - c.at < CRACK_MS);
  for (const it of g.items) {
    if (itemStep(it, now) < STEPS) {
      items.push(it);
      continue;
    }
    if (it.lane === basket) {
      caught++;
      events.push({ kind: "catch", lane: it.lane });
    } else {
      missed++;
      cracks.push({ lane: it.lane, at: now });
      events.push({ kind: "miss", lane: it.lane });
    }
  }
  if (items.length < MAX_ITEMS && now - lastSpawn >= spawnGap(budget)) {
    let r: number;
    [r, seed] = rnd(seed);
    let lane = Math.floor(r * 4) as Lane;
    // Not the lane of the newest item (two at once on one chute would overlap).
    const newest = items[items.length - 1];
    if (newest && newest.lane === lane && now - newest.born < STEP_MS * 2) lane = ((lane + 1 + Math.floor(r * 3)) % 4) as Lane;
    items.push({ id: nextId++, lane, born: now });
    lastSpawn = now;
    budget = Math.max(0, budget - 1);
  }
  return { game: { items, cracks, caught, missed, budget, lastP: Math.max(g.lastP, p), lastSpawn, nextId, seed }, events };
}
