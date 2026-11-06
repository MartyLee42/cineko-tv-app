// Sleep timer for the player (pure; the view keeps the state). Per playback
// session, never persisted. «After this episode» stops at the episode's end
// instead of the next-episode countdown; a time timer dims the screen for
// its last minute (any key there extends it by 10 min), then pauses.

export type SleepChoice = "off" | "episode" | 15 | 30 | 60 | 90;
export const SLEEP_CHOICES: readonly SleepChoice[] = ["off", "episode", 15, 30, 60, 90];

export type SleepState = { mode: "off" } | { mode: "episode" } | { mode: "time"; endsAt: number };

export const SLEEP_OFF: SleepState = { mode: "off" };
/** The dim lasts this long before the timer fires. */
export const DIM_MS = 60_000;
/** Darkest the dim gets (the goodnight screen goes darker still). */
export const DIM_MAX = 0.85;
/** How much the volume drops by the end of the dim (a share of the user's level). */
export const DIM_VOLUME_DROP = 0.4;
export const EXTEND_MS = 10 * 60_000;

export function startSleep(choice: SleepChoice, now: number): SleepState {
  if (choice === "off") return SLEEP_OFF;
  if (choice === "episode") return { mode: "episode" };
  return { mode: "time", endsAt: now + choice * 60_000 };
}

/** What the panel shows as selected (a running time timer counts down, so no preset stays ticked). */
export function sleepChoiceOf(s: SleepState, choice: SleepChoice): boolean {
  if (choice === "off") return s.mode === "off";
  if (choice === "episode") return s.mode === "episode";
  return false;
}

export function remainingMs(s: SleepState, now: number): number | null {
  return s.mode === "time" ? Math.max(0, s.endsAt - now) : null;
}

/** Whole minutes left, rounded up («Сон через 24 мин»); null without a time timer. */
export function remainingMinutes(s: SleepState, now: number): number | null {
  const ms = remainingMs(s, now);
  return ms === null ? null : Math.max(1, Math.ceil(ms / 60_000));
}

/** 0 → 1 over the last DIM_MS (0 before it). */
export function dimProgress(s: SleepState, now: number): number {
  const ms = remainingMs(s, now);
  if (ms === null || ms >= DIM_MS) return 0;
  return Math.min(1, 1 - ms / DIM_MS);
}

/** Overlay opacity for the dim. */
export function dimOpacity(s: SleepState, now: number): number {
  return dimProgress(s, now) * DIM_MAX;
}

/** Volume factor for the dim (1 → 1 - DIM_VOLUME_DROP). */
export function dimVolume(s: SleepState, now: number): number {
  return 1 - dimProgress(s, now) * DIM_VOLUME_DROP;
}

/** In the last minute, not yet fired. */
export function dimming(s: SleepState, now: number): boolean {
  return dimProgress(s, now) > 0 && !due(s, now);
}

/** A key during the dim: 10 more minutes. */
export function extendSleep(s: SleepState, now: number): SleepState {
  if (s.mode !== "time") return s;
  return { mode: "time", endsAt: Math.max(s.endsAt, now) + EXTEND_MS };
}

/** The time timer has run out. */
export function due(s: SleepState, now: number): boolean {
  return s.mode === "time" && now >= s.endsAt;
}

/** The episode ended: the goodnight screen instead of the next one? */
export function sleepAtEpisodeEnd(s: SleepState): boolean {
  return s.mode === "episode";
}
