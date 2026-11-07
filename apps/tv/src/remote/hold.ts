// OK held vs tapped on a card: OK acts on release when the card has a
// long-press action; holding it LONG_PRESS_MS fires that action instead (and
// the release then does nothing). Auto-repeated keydowns while held are
// ignored. Timers are injectable for tests.

export const LONG_PRESS_MS = 700;

type Schedule = (fn: () => void, ms: number) => unknown;
type Cancel = (id: unknown) => void;

export class Hold {
  private timer: unknown = null;
  private isDown = false;
  private fired = false;

  constructor(
    private readonly ms = LONG_PRESS_MS,
    private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: Cancel = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  ) {}

  /** OK went down (repeats while held are ignored). */
  down(onLong: () => void) {
    if (this.isDown) return;
    this.isDown = true;
    this.fired = false;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.fired = true;
      onLong();
    }, this.ms);
  }

  /** OK released: true when it was a short press (the caller runs the normal action). */
  up(): boolean {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    const short = this.isDown && !this.fired;
    this.isDown = false;
    return short;
  }

  /** Focus left / unmount: forget a pending press. */
  reset() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.isDown = false;
    this.fired = false;
  }
}
