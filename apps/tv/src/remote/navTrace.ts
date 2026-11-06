// Diagnostics for the menu bar: when Left/Right in the menu lands anywhere but
// the neighbouring tab (a "skip" seen on some real TVs, not in browsers),
// report what the TV saw — the key events around the press and the tab
// geometry the focus engine measures — as a "console" client report.
import { getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import { reportError } from "@martytv/ui";

const MAX_REPORTS = 5;

type KeyRec = { t: number; key: string; code: number; repeat: boolean; from: string };

function tabs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("nav [data-menu]"));
}

function geometry(list: HTMLElement[]): string {
  return list
    .map((el) => {
      const r = el.getBoundingClientRect();
      return `${el.dataset.menu}:${Math.round(el.offsetLeft)}+${Math.round(el.offsetWidth)}/${Math.round(r.left)}+${Math.round(r.width)}`;
    })
    .join(" ");
}

export function installNavTrace(): void {
  let reports = 0;
  const recent: KeyRec[] = [];
  window.addEventListener(
    "keydown",
    (e) => {
      const from = getCurrentFocusKey() ?? "";
      const t = performance.now();
      recent.push({ t, key: e.key, code: e.keyCode, repeat: e.repeat, from });
      while (recent.length > 12) recent.shift();
      const dir = e.key === "ArrowRight" || e.keyCode === 39 ? 1 : e.key === "ArrowLeft" || e.keyCode === 37 ? -1 : 0;
      if (!dir || !from.startsWith("menu-") || reports >= MAX_REPORTS) return;
      const list = tabs();
      const ids = list.map((el) => `menu-${el.dataset.menu}`);
      const i = ids.indexOf(from);
      // Only a horizontal bar (tabs side by side) has a left/right neighbour.
      if (i < 0 || list.length < 2 || Math.abs(list[1]!.offsetTop - list[0]!.offsetTop) > 20) return;
      const expected = ids[i + dir];
      if (!expected) return;
      // How long the TV takes to move focus (lag), sampled every frame-ish.
      let movedAt: number | null = null;
      const poll = setInterval(() => {
        if (movedAt === null && (getCurrentFocusKey() ?? "") !== from) movedAt = performance.now();
      }, 16);
      setTimeout(() => {
        clearInterval(poll);
        const to = getCurrentFocusKey() ?? "";
        if (to === expected || to === from) return;
        // Another key pressed meanwhile (Right, Right… or Right, OK): not a one-press skip —
        // unless it's the same arrow < 120 ms later (too fast for a person: a duplicate event).
        const later = recent.filter((k) => k.t > t);
        const duplicate = later.some((k) => k.key === e.key && !k.repeat && k.t - t < 120);
        if (later.length > 0 && !duplicate) return;
        reports++;
        const extra = {
            from,
            expected,
            to,
            // Not "keys": the server blanks JSON fields named like credentials (…key…).
            presses: recent
              .filter((k) => t - k.t < 1500 || k.t >= t)
              .map((k) => `${Math.round(k.t - t)}ms ${k.key}/${k.code}${k.repeat ? " rep" : ""} @${k.from}`)
              .join(" | "),
            tabs: geometry(list),
            moved_after_ms: movedAt === null ? null : Math.round(movedAt - t),
            duplicate_event: duplicate,
            viewport: `${window.innerWidth}x${window.innerHeight} dpr${window.devicePixelRatio}`,
        };
        // Tests read what was detected here (the report itself goes out batched).
        const w = window as unknown as { __martytvNavSkips?: unknown[] };
        (w.__martytvNavSkips ??= []).push(extra);
        reportError("console", new Error("menu nav skipped a tab"), { component: "menu", extra });
      }, 350);
    },
    true,
  );
}
