// «Cineko TV» session: the programme, which pick is on, channel up / down,
// «Не то», more picks when the list runs low, the OSD. Playback, the API and
// the clock come in as deps (tests drive it with fakes).
import { appendFresh, excludeIds, runningLow, stepIndex, type ChannelItem } from "./schedule";

export type ChannelPhase = "tuning" | "on" | "empty" | "error";
/** strip: «сейчас / далее» for a few seconds; guide: the programme with buttons (OK). */
export type OsdMode = "strip" | "guide" | null;
export const OSD_BUTTONS = ["next", "not_this", "tracks", "leave"] as const;
export type OsdButton = (typeof OSD_BUTTONS)[number];

export const STRIP_MS = 7000;
export const GUIDE_MS = 15_000;
/** A batch of picks per request. */
export const BATCH = 8;
/** Picks that fail to start in a row before the channel gives up. */
export const MAX_FAILS = 4;

export interface ChannelDeps {
  load(count: number, exclude: string[]): Promise<ChannelItem[]>;
  /** Starts a pick (the normal player, best release). */
  play(item: ChannelItem): void;
  /** Stops playback (leaving the channel). */
  stop(): void;
  /** Warms the next pick's release decision. */
  prefetch(item: ChannelItem): void;
  /** «Не интересно» from the channel. */
  dismiss(mediaId: string): void;
  /** Feedback attributed to the channel (impression + play). */
  played(mediaId: string): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

export interface ChannelSnapshot {
  phase: ChannelPhase;
  items: ChannelItem[];
  index: number;
  /** When the current pick was tuned in (ms). */
  startedAt: number;
  osd: OsdMode;
  focus: number;
  /** Waiting for more picks after channel up at the end of the list. */
  waiting: boolean;
  /** Bumped on every change (useSyncExternalStore). */
  v: number;
}

export class ChannelSession {
  private s: ChannelSnapshot = { phase: "tuning", items: [], index: -1, startedAt: 0, osd: null, focus: 0, waiting: false, v: 0 };
  private listeners = new Set<() => void>();
  private gone = new Set<string>();
  private loading: Promise<void> | null = null;
  private osdTimer: unknown = null;
  private prefetchTimer: unknown = null;
  private fails = 0;
  private closed = false;

  constructor(private d: ChannelDeps) {}

  get = (): ChannelSnapshot => this.s;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  private set(p: Partial<ChannelSnapshot>) {
    this.s = { ...this.s, ...p, v: this.s.v + 1 };
    this.listeners.forEach((l) => l());
  }

  current(): ChannelItem | null {
    return this.s.items[this.s.index] ?? null;
  }

  /** Tunes in: the first batch, then its first pick. */
  async start(): Promise<void> {
    this.set({ phase: "tuning" });
    try {
      const items = await this.d.load(BATCH, []);
      if (this.closed) return;
      if (items.length === 0) return this.set({ phase: "empty" });
      this.set({ items: appendFresh([], items), phase: "on" });
      this.tune(0);
    } catch {
      if (!this.closed) this.set({ phase: "error" });
    }
  }

  /** Channel up: the next pick (more are fetched when the list runs low). */
  next(): void {
    if (this.s.phase !== "on") return;
    const to = stepIndex(this.s.index, 1, this.s.items.length);
    if (to !== null) return this.tune(to);
    // The end of the list: wait for the next batch, then go on.
    this.set({ waiting: true });
    void this.more().then(() => {
      if (this.closed || !this.s.waiting) return;
      this.set({ waiting: false });
      const at = stepIndex(this.s.index, 1, this.s.items.length);
      if (at !== null) this.tune(at);
      else this.set({ phase: "empty" });
    });
  }

  /** Channel down: the previous pick (from its beginning). */
  prev(): void {
    if (this.s.phase !== "on") return;
    const to = stepIndex(this.s.index, -1, this.s.items.length);
    if (to !== null) this.tune(to);
  }

  /** «Не то»: a «Не интересно» signal, and the next pick. */
  notThis(): void {
    const cur = this.current();
    if (!cur || this.s.phase !== "on") return;
    this.gone.add(cur.media.id);
    this.d.dismiss(cur.media.id);
    // It never comes back on this session's programme either.
    const items = this.s.items.filter((it, i) => i <= this.s.index || it.media.id !== cur.media.id);
    this.set({ items });
    this.next();
  }

  /** The title ended: straight to the next pick (no «Up next» prompt). */
  ended(): void {
    this.fails = 0;
    this.next();
  }

  /** The pick failed to start: skip it (a few in a row → give up). */
  failed(): void {
    if (this.s.phase !== "on") return;
    this.fails++;
    if (this.fails >= MAX_FAILS) {
      this.d.stop();
      return this.set({ phase: "error", osd: null });
    }
    this.next();
  }

  /** Playback started for real: the failure streak ends. */
  started(): void {
    this.fails = 0;
  }

  leave(): void {
    if (this.closed) return;
    this.closed = true;
    this.d.clearTimer(this.osdTimer);
    this.d.clearTimer(this.prefetchTimer);
    this.d.stop();
  }

  // ---------------------------------------------------------------- OSD

  showStrip(): void {
    this.osd("strip", STRIP_MS);
  }

  showGuide(): void {
    this.osd("guide", GUIDE_MS, this.s.osd === "guide" ? this.s.focus : 0);
  }

  hideOsd(): void {
    this.d.clearTimer(this.osdTimer);
    this.set({ osd: null });
  }

  /** ◀▶ in the guide. */
  moveFocus(dir: 1 | -1): void {
    const focus = Math.min(OSD_BUTTONS.length - 1, Math.max(0, this.s.focus + dir));
    this.osd("guide", GUIDE_MS, focus);
  }

  focused(): OsdButton {
    return OSD_BUTTONS[this.s.focus] ?? "next";
  }

  private osd(mode: OsdMode, ms: number, focus = this.s.focus) {
    this.d.clearTimer(this.osdTimer);
    this.set({ osd: mode, focus });
    this.osdTimer = this.d.setTimer(() => this.set({ osd: null }), ms);
  }

  // ---------------------------------------------------------------- internals

  private tune(index: number) {
    const it = this.s.items[index];
    if (!it) return;
    this.set({ index, startedAt: this.d.now(), waiting: false });
    this.showStrip();
    this.d.played(it.media.id);
    this.d.play(it);
    // The next pick's release, a while after this one started.
    this.d.clearTimer(this.prefetchTimer);
    this.prefetchTimer = this.d.setTimer(() => {
      const nx = this.s.items[this.s.index + 1];
      if (nx && !this.closed) this.d.prefetch(nx);
    }, 45_000);
    if (runningLow(index, this.s.items.length)) void this.more();
  }

  /** Fetches the next batch (one request at a time). */
  private more(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.d
      .load(BATCH, excludeIds(this.s.items, this.gone))
      .then((more) => {
        if (this.closed) return;
        const items = appendFresh(this.s.items, more, this.gone);
        if (items.length !== this.s.items.length) this.set({ items });
      })
      .catch(() => undefined)
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }
}

