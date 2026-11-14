// A «slow TV» for the browser tests: the TV app in Chromium with a weak
// CPU (CDP CPU throttling), a TV-like link, and the quirks TV video engines
// show that desktop Chromium doesn't:
//
//  - slowSeekMs:    a seek takes this long, and meanwhile currentTime reads 0
//                   (Tizen / webOS report 0 until the new spot decodes);
//  - dropStartSeek: the first seek before playback starts is silently dropped;
//  - cut("end"):    the link dies and the engine leaps to the end of the file
//                   and fires "ended" (seen on TVs when the stream breaks);
//  - cut("shrink"): …or takes the cut-off point for the file's length.
//
// A recorder logs, frame by frame, what the screen shows (the app screen,
// the startup intro, the loading screen's percentage, the player's bar), so
// a test can assert there is no flash, no bar going back and forth, and no
// jump to the end.
import type { BrowserContext, Page } from "@playwright/test";

export interface TvQuirks {
  slowSeekMs?: number;
  dropStartSeek?: boolean;
}

export interface TvSample {
  /** ms since the page started. */
  t: number;
  /** What covers the screen: "intro" while the startup intro is visible, else the app's screen (data-screen). */
  screen: string;
  /** The loading screen's percentage (data-progress), null when it isn't shown. */
  load: number | null;
  /** Distinct loading-screen elements seen so far (a remount restarts its animation). */
  loaderMounts: number;
  /** The player's bar (window.__playerBar), null outside playback. */
  pos: number | null;
  dur: number | null;
}

/** CPU slowdown (×), from TV_CPU; 6 is roughly a 2018 Tizen / webOS TV. */
export const TV_CPU = Number(process.env.TV_CPU ?? 6);

/** Runs in the page before the app: the engine quirks and the recorder. */
function install(quirks: TvQuirks) {
  type St = { fakeTime: number | null; fakeDur: number | null; played: boolean; dropped: boolean; seekUntil: number };
  const states = new WeakMap<HTMLMediaElement, St>();
  const st = (m: HTMLMediaElement): St => {
    let s = states.get(m);
    if (!s) states.set(m, (s = { fakeTime: null, fakeDur: null, played: false, dropped: false, seekUntil: 0 }));
    return s;
  };
  const proto = HTMLMediaElement.prototype;
  const ct = Object.getOwnPropertyDescriptor(proto, "currentTime")!;
  const du = Object.getOwnPropertyDescriptor(proto, "duration")!;
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      const s = st(this);
      if (s.fakeTime !== null) return s.fakeTime;
      if (performance.now() < s.seekUntil) return 0;
      return ct.get!.call(this);
    },
    set(this: HTMLMediaElement, x: number) {
      const s = st(this);
      s.fakeTime = null;
      if (quirks.dropStartSeek && !s.played && !s.dropped && x > 0) {
        s.dropped = true;
        return;
      }
      if (quirks.slowSeekMs) s.seekUntil = performance.now() + quirks.slowSeekMs;
      ct.set!.call(this, x);
    },
  });
  Object.defineProperty(proto, "duration", {
    configurable: true,
    get(this: HTMLMediaElement) {
      const s = st(this);
      return s.fakeDur ?? du.get!.call(this);
    },
  });
  document.addEventListener("playing", (e) => (st(e.target as HTMLMediaElement).played = true), true);
  // A new src: the engine starts clean (the cut is over).
  document.addEventListener(
    "loadstart",
    (e) => {
      const s = st(e.target as HTMLMediaElement);
      s.fakeTime = s.fakeDur = null;
    },
    true,
  );

  const w = window as unknown as {
    __tvEngine: { cut(mode: "end" | "shrink"): void };
    __tvLog: TvSample[];
    __playerBar?: () => { phase: string; pos: number; dur: number | null };
  };
  w.__tvEngine = {
    cut(mode) {
      const v = document.querySelector<HTMLVideoElement>("[data-testid=player] video");
      if (!v) throw new Error("no player video");
      const s = st(v);
      const real = du.get!.call(v) as number;
      const at = ct.get!.call(v) as number;
      if (mode === "end") s.fakeTime = real;
      else s.fakeTime = s.fakeDur = at + 0.5;
      if (mode === "shrink") v.dispatchEvent(new Event("durationchange"));
      v.dispatchEvent(new Event("timeupdate"));
      v.dispatchEvent(new Event("ended"));
    },
  };

  const log: TvSample[] = [];
  w.__tvLog = log;
  // Poster blinks: a card image that already showed once comes back hidden
  // (a virtualized row remounts cards that scroll back into its window).
  const loaded = new Set<string>();
  const blinks: string[] = [];
  (window as unknown as { __tvBlinks: string[] }).__tvBlinks = blinks;
  document.addEventListener("load", (e) => e.target instanceof HTMLImageElement && loaded.add(e.target.src), true);
  new MutationObserver((muts) => {
    for (const m of muts)
      m.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        const imgs = n instanceof HTMLImageElement ? [n] : Array.from(n.querySelectorAll("img"));
        for (const img of imgs) {
          if (!img.closest("[data-card-id]") || !loaded.has(img.src)) continue;
          if (parseFloat(getComputedStyle(img).opacity) < 0.99) blinks.push(img.src);
        }
      });
  }).observe(document, { subtree: true, childList: true });
  const loaders = new WeakSet<Element>();
  let mounts = 0;
  let last = "";
  const sample = () => {
    const intro = document.querySelector("[data-testid=startup-intro], [data-testid=startup-intro-wait]");
    const introOn = !!intro && parseFloat(getComputedStyle(intro).opacity) > 0.05;
    const screen = document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? "none";
    const loader = document.querySelector("[data-testid=player-preparing]");
    if (loader && !loaders.has(loader)) {
      loaders.add(loader);
      mounts++;
    }
    let bar: { phase: string; pos: number; dur: number | null } | null;
    try {
      bar = w.__playerBar?.() ?? null;
    } catch {
      bar = null;
    }
    const s: TvSample = {
      t: Math.round(performance.now()),
      screen: introOn ? "intro" : screen,
      load: loader ? Number(loader.getAttribute("data-progress")) : null,
      loaderMounts: mounts,
      pos: bar && bar.phase === "playing" ? Math.round(bar.pos) : null,
      dur: bar && bar.phase === "playing" && bar.dur ? Math.round(bar.dur) : null,
    };
    const key = `${s.screen}|${s.load}|${s.loaderMounts}|${s.pos}|${s.dur}`;
    if (key !== last) {
      last = key;
      log.push(s);
    }
  };
  const frame = () => {
    sample();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Between frames too (a flash shorter than a throttled frame).
  new MutationObserver(sample).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-screen", "data-progress", "style"] });
}

/** Makes `page` a slow TV (call before its first goto). */
export async function emulateTv(ctx: BrowserContext, page: Page, quirks: TvQuirks = {}) {
  await page.addInitScript(install, quirks);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: TV_CPU });
  // A TV on Wi-Fi: some latency, ~25 Mbit/s.
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: (25e6 / 8) | 0, uploadThroughput: (10e6 / 8) | 0 });
}

/** The recorder's log (and clears it). */
export async function takeLog(page: Page): Promise<TvSample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __tvLog: TvSample[] };
    return w.__tvLog.splice(0);
  });
}

/** Screens shown after Home first showed uncovered (a flash of the boot screen / intro). */
export function flashesAfterHome(log: TvSample[]): TvSample[] {
  const i = log.findIndex((s) => s.screen === "home");
  return i < 0 ? [] : log.slice(i + 1).filter((s) => s.screen !== "home");
}

/** Places where the loading percentage went down. */
export function loadDrops(log: TvSample[]): { from: number; to: number; t: number }[] {
  const out: { from: number; to: number; t: number }[] = [];
  let max = -1;
  for (const s of log) {
    if (s.load === null) continue;
    if (s.load < max) out.push({ from: max, to: s.load, t: s.t });
    max = Math.max(max, s.load);
  }
  return out;
}

/** Bar positions after it first reached `target` that fell back far below it (back and forth). */
export function barBounces(log: TvSample[], target: number, slack = 5): TvSample[] {
  const i = log.findIndex((s) => s.pos !== null && s.pos >= target - 1);
  return i < 0 ? [] : log.slice(i + 1).filter((s) => s.pos !== null && s.pos < target - slack);
}

/** A compact timeline for the test's output. */
export function timeline(log: TvSample[]): string {
  return log.map((s) => `${String(s.t).padStart(6)}ms ${s.screen.padEnd(8)} load=${s.load ?? "-"} mounts=${s.loaderMounts} pos=${s.pos ?? "-"}/${s.dur ?? "-"}`).join("\n");
}

/** Card images that came back hidden since the last call (and clears the list). */
export async function takeBlinks(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __tvBlinks: string[] }).__tvBlinks.splice(0));
}
