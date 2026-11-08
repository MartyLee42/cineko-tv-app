// Thumbnail prefetch for the «Видео» rows (TV) and lists (PWA): the next
// cards of the focused row and the start of the rows around it are loaded
// into the browser's cache before they scroll in (lazy images in a clipped
// row only start loading once visible). Low priority: at most a couple of
// loads at a time, started when the engine is idle; the newest request goes
// first and old ones beyond the queue's length are dropped.

export interface PrefetchOptions {
  /** Starts loading one URL; `done` once it finished (loaded or not). */
  load(url: string, done: () => void): void;
  /** Loads at a time (default 2). */
  maxInFlight?: number;
  /** Waiting URLs kept (default 40; the oldest go). */
  maxQueue?: number;
  /** URLs remembered as loaded, not asked for again (default 600). */
  remember?: number;
  /** Runs `cb` when the engine is idle (default: right away). */
  idle?(cb: () => void): void;
}

export class ThumbPrefetcher {
  private queue: string[] = [];
  private readonly inFlight = new Set<string>();
  private readonly seen = new Set<string>(); // insertion order = age
  private scheduled = false;
  private readonly o: Required<Omit<PrefetchOptions, "idle">> & Pick<PrefetchOptions, "idle">;

  constructor(o: PrefetchOptions) {
    this.o = { maxInFlight: 2, maxQueue: 40, remember: 600, ...o };
  }

  /** Prefetch these (in this order) before anything asked for earlier. */
  want(urls: readonly (string | null | undefined)[]): void {
    const fresh: string[] = [];
    for (const u of urls) {
      if (u && !this.seen.has(u) && !this.inFlight.has(u) && !fresh.includes(u)) fresh.push(u);
    }
    if (fresh.length === 0) return;
    this.queue = [...fresh, ...this.queue.filter((u) => !fresh.includes(u))].slice(0, this.o.maxQueue);
    this.schedule();
  }

  /** Drop what is still waiting (leaving the screen). */
  clear(): void {
    this.queue = [];
  }

  /** Waiting + loading (tests, debugging). */
  pending(): number {
    return this.queue.length + this.inFlight.size;
  }

  private schedule(): void {
    if (this.scheduled || this.queue.length === 0 || this.inFlight.size >= this.o.maxInFlight) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      this.pump();
    };
    if (this.o.idle) this.o.idle(run);
    else run();
  }

  private pump(): void {
    while (this.inFlight.size < this.o.maxInFlight && this.queue.length > 0) {
      const u = this.queue.shift()!;
      this.inFlight.add(u);
      let finished = false;
      this.o.load(u, () => {
        if (finished) return;
        finished = true;
        this.inFlight.delete(u);
        this.remember(u);
        this.schedule();
      });
    }
  }

  private remember(u: string): void {
    this.seen.add(u);
    if (this.seen.size > this.o.remember) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

/**
 * What to prefetch around the focused card: the next cards of its row
 * (the nearest first), the start of the row below from where its focus
 * sits, then the rest of this row's lookahead and a few of the row above.
 */
export function nearbyThumbs(
  rows: readonly (readonly (string | null | undefined)[])[],
  row: number,
  idx: number,
  o: { ahead?: number; next?: number; starts?: readonly number[] } = {},
): string[] {
  const ahead = o.ahead ?? 10;
  const next = o.next ?? 6;
  const cur = rows[row] ?? [];
  const near = Math.ceil(ahead / 2);
  const at = (r: number) => Math.max(0, o.starts?.[r] ?? 0);
  const below = rows[row + 1] ?? [];
  const above = rows[row - 1] ?? [];
  const out = [
    ...cur.slice(idx + 1, idx + 1 + near),
    ...below.slice(at(row + 1), at(row + 1) + next),
    ...cur.slice(idx + 1 + near, idx + 1 + ahead),
    ...above.slice(at(row - 1), at(row - 1) + 3),
  ];
  return uniq(out);
}

/** A grid (search, a channel): the rest of the focused line and the next `linesAhead` lines. */
export function gridThumbs(urls: readonly (string | null | undefined)[], idx: number, cols: number, linesAhead = 2): string[] {
  const c = Math.max(1, cols);
  return uniq(urls.slice(idx + 1, (Math.floor(idx / c) + 1 + linesAhead) * c));
}

function uniq(us: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  return us.filter((u): u is string => !!u && !seen.has(u) && !!seen.add(u));
}
