// Spatial D-pad navigation for the TV build.
//
// Focusable elements carry `data-f` (and a stable `data-fk` key). The arrow
// keys move to the nearest focusable in that direction (geometry of the
// rendered boxes, so it follows any layout); a `data-group` ancestor
// remembers its last focused child, so going down into a row lands where you
// left it. A `data-scope` element (an open panel) traps focus inside. The
// focused element gets `data-focused` (React never touches that attribute)
// and is scrolled into view inside its `data-scroll="x|y"` ancestors.
// Enter/OK clicks it. Screens / the player can take keys first (pushKeys).

export type Dir = "left" | "right" | "up" | "down";
export type Key = Dir | "ok" | "back" | "playpause" | "play" | "pause" | "stop" | "ff" | "rew" | "next" | "prev" | "other";

const BY_KEY: Record<string, Key> = {
  ArrowLeft: "left",
  Left: "left",
  ArrowRight: "right",
  Right: "right",
  ArrowUp: "up",
  Up: "up",
  ArrowDown: "down",
  Down: "down",
  Enter: "ok",
  Accept: "ok",
  Escape: "back",
  GoBack: "back",
  BrowserBack: "back",
  Backspace: "back",
  MediaPlayPause: "playpause",
  " ": "playpause",
  MediaPlay: "play",
  Play: "play",
  MediaPause: "pause",
  Pause: "pause",
  MediaStop: "stop",
  Stop: "stop",
  MediaFastForward: "ff",
  FastFwd: "ff",
  MediaRewind: "rew",
  Rewind: "rew",
  MediaTrackNext: "next",
  MediaNextTrack: "next",
  MediaTrackPrevious: "prev",
  MediaPreviousTrack: "prev",
};

const BY_CODE: Record<number, Key> = {
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  13: "ok",
  29443: "ok", // Samsung Enter (old)
  8: "back",
  27: "back",
  461: "back", // LG webOS
  10009: "back", // Samsung Tizen
  166: "back",
  179: "playpause",
  10252: "playpause",
  415: "play",
  250: "play",
  19: "pause",
  413: "stop",
  178: "stop",
  417: "ff",
  412: "rew",
  176: "next",
  10233: "next",
  177: "prev",
  10232: "prev",
};

export function keyOf(e: KeyboardEvent): Key {
  const t = e.target as HTMLElement | null;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  if (typing && (e.key === "Backspace" || e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight")) return "other";
  return BY_KEY[e.key] ?? BY_CODE[e.keyCode] ?? "other";
}

// ---------------------------------------------------------------- state

let current: HTMLElement | null = null;
let currentKey = "";
const groupMemory = new Map<string, string>(); // group id → focus key
type FocusListener = (el: HTMLElement) => void;
const focusListeners = new Set<FocusListener>();

function root(): HTMLElement {
  return document.getElementById("root") ?? document.body;
}

function scopeEl(): HTMLElement {
  const scopes = root().querySelectorAll<HTMLElement>("[data-scope]");
  return scopes.length ? scopes[scopes.length - 1] : root();
}

function visible(el: HTMLElement): boolean {
  if (!el.isConnected || el.offsetParent === null) return false;
  if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function focusables(scope: HTMLElement = scopeEl()): HTMLElement[] {
  return Array.prototype.slice.call(scope.querySelectorAll<HTMLElement>("[data-f]")).filter(visible);
}

function groupOf(el: HTMLElement): HTMLElement | null {
  return el.parentElement ? (el.parentElement.closest("[data-group]") as HTMLElement | null) : null;
}

export function focused(): HTMLElement | null {
  return current && current.isConnected ? current : null;
}

export function focusedKey(): string {
  return currentKey;
}

export function onFocusChange(cb: FocusListener): () => void {
  focusListeners.add(cb);
  return () => focusListeners.delete(cb);
}

function scaleOf(el: HTMLElement): number {
  const w = el.offsetWidth;
  return w ? el.getBoundingClientRect().width / w : 1;
}

/** Scrolls `el` into view inside its data-scroll ancestors (overflow: hidden containers). */
export function reveal(el: HTMLElement): void {
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    const axis = node.getAttribute("data-scroll");
    if (axis) {
      const s = scaleOf(node) || 1;
      const c = node.getBoundingClientRect();
      const target = (axis === "y" ? (el.closest("[data-row]") as HTMLElement | null) : null) ?? el;
      const r = target.getBoundingClientRect();
      if (axis === "x") {
        const pad = Number(node.getAttribute("data-pad") ?? 60) * s;
        if (r.right > c.right - pad) node.scrollLeft += (r.right - (c.right - pad)) / s;
        else if (r.left < c.left + pad) node.scrollLeft -= (c.left + pad - r.left) / s;
      } else {
        const mode = node.getAttribute("data-align");
        const pad = Number(node.getAttribute("data-pad") ?? 90) * s;
        if (mode === "top") node.scrollTop += (r.top - c.top - pad) / s;
        else if (r.bottom > c.bottom - pad) node.scrollTop += (r.bottom - (c.bottom - pad)) / s;
        else if (r.top < c.top + pad) node.scrollTop -= (c.top + pad - r.top) / s;
      }
    }
    node = node.parentElement;
  }
}

export function focus(el: HTMLElement | null, opts: { silent?: boolean } = {}): boolean {
  if (!el) return false;
  if (current && current !== el) current.removeAttribute("data-focused");
  current = el;
  currentKey = el.getAttribute("data-fk") ?? "";
  el.setAttribute("data-focused", "");
  let g = groupOf(el);
  while (g) {
    const id = g.getAttribute("data-group");
    if (id && currentKey) groupMemory.set(id, currentKey);
    g = groupOf(g);
  }
  reveal(el);
  if (!opts.silent) {
    focusListeners.forEach((l) => l(el));
    try {
      el.dispatchEvent(new CustomEvent("tvfocus"));
    } catch {
      /* very old engines */
    }
  }
  return true;
}

export function byKey(fk: string, scope: HTMLElement = root()): HTMLElement | null {
  if (!fk) return null;
  const all = scope.querySelectorAll<HTMLElement>("[data-f]");
  for (let i = 0; i < all.length; i++) if (all[i].getAttribute("data-fk") === fk && visible(all[i])) return all[i];
  return null;
}

export function focusKey(fk: string): boolean {
  return focus(byKey(fk));
}

/** Focuses the remembered key, else the first [data-autofocus], else the first focusable of the scope. */
export function focusInitial(remembered?: string, within?: HTMLElement | null): boolean {
  const scope = within ?? scopeEl();
  if (remembered) {
    const el = byKey(remembered, scope);
    if (el) return focus(el);
  }
  const auto = Array.prototype.slice.call(scope.querySelectorAll<HTMLElement>("[data-autofocus]")).filter(visible)[0] as HTMLElement | undefined;
  if (auto) return focus(auto);
  const first = focusables(scope)[0];
  return focus(first ?? null);
}

/** When the focused element vanished (re-render), recover by key or start over. */
export function ensure(): HTMLElement | null {
  const scope = scopeEl();
  if (current && current.isConnected && visible(current) && scope.contains(current)) return current;
  const again = currentKey ? byKey(currentKey, scope) : null;
  if (again) {
    focus(again, { silent: true });
    return again;
  }
  focusInitial(undefined, scope);
  return null;
}

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
  cx: number;
  cy: number;
}

function box(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
}

function candidate(c: Box, o: Box, dir: Dir): number {
  const eps = 2;
  let primary: number;
  let overlap: number;
  let offset: number;
  switch (dir) {
    case "right":
      if (o.l < c.r - eps && o.cx <= c.cx + eps) return -1;
      if (o.cx <= c.cx) return -1;
      primary = Math.max(0, o.l - c.r);
      overlap = Math.min(c.b, o.b) - Math.max(c.t, o.t);
      offset = Math.abs(o.cy - c.cy);
      break;
    case "left":
      if (o.cx >= c.cx) return -1;
      primary = Math.max(0, c.l - o.r);
      overlap = Math.min(c.b, o.b) - Math.max(c.t, o.t);
      offset = Math.abs(o.cy - c.cy);
      break;
    case "down":
      if (o.cy <= c.cy || o.t < c.t + eps) return -1;
      primary = Math.max(0, o.t - c.b);
      overlap = Math.min(c.r, o.r) - Math.max(c.l, o.l);
      offset = Math.abs(o.cx - c.cx);
      break;
    default:
      if (o.cy >= c.cy || o.b > c.b - eps) return -1;
      primary = Math.max(0, c.t - o.b);
      overlap = Math.min(c.r, o.r) - Math.max(c.l, o.l);
      offset = Math.abs(o.cx - c.cx);
  }
  // Boxes that share the row/column win; then the closest edge, then alignment.
  return (overlap > 0 ? 0 : 100000) + primary * 1 + offset * (overlap > 0 ? 0.3 : 2);
}

/** Moves focus; false when nothing lies in that direction. */
export function move(dir: Dir): boolean {
  const cur = ensure();
  if (!cur) return true;
  const c = box(cur);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of focusables()) {
    if (el === cur) continue;
    const s = candidate(c, box(el), dir);
    if (s >= 0 && s < bestScore) {
      bestScore = s;
      best = el;
    }
  }
  if (!best) return false;
  // Entering another group: go back to where you were in it.
  const from = groupOf(cur);
  let g = groupOf(best);
  // Use the outermost group that doesn't contain the current element.
  let target: HTMLElement | null = null;
  while (g && !g.contains(cur)) {
    target = g;
    g = groupOf(g);
  }
  if (target && target !== from) {
    const id = target.getAttribute("data-group") ?? "";
    const remembered = groupMemory.get(id);
    // Never been in this group: its [data-default] element (e.g. the active rail item).
    let el = remembered ? byKey(remembered, target) : null;
    if (!el) {
      const d = target.querySelector<HTMLElement>("[data-default]");
      el = d && visible(d) ? d : null;
    }
    if (el && el !== cur && candidate(c, box(el), dir) >= 0) best = el;
    else if (el && el !== cur && (dir === "up" || dir === "down")) best = el;
  }
  return focus(best);
}

export function click(): void {
  const cur = ensure();
  if (cur) cur.click();
}

// ---------------------------------------------------------------- key routing

export type KeyHandler = (k: Key, e: KeyboardEvent) => boolean | void;
const handlers: KeyHandler[] = [];

/** Registers a handler that sees keys before navigation (last pushed first). */
export function pushKeys(h: KeyHandler): () => void {
  handlers.push(h);
  return () => {
    const i = handlers.lastIndexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}

let backHandler: () => void = () => undefined;
export function setBackHandler(h: () => void): void {
  backHandler = h;
}

export function installNav(): void {
  window.addEventListener("keydown", (e) => {
    const k = keyOf(e);
    if (k === "other") return;
    for (let i = handlers.length - 1; i >= 0; i--) {
      if (handlers[i](k, e)) {
        e.preventDefault();
        return;
      }
    }
    switch (k) {
      case "left":
      case "right":
      case "up":
      case "down":
        e.preventDefault();
        move(k);
        break;
      case "ok":
        e.preventDefault();
        click();
        break;
      case "back":
        e.preventDefault();
        backHandler();
        break;
      default:
    }
  });
  // Mouse / Magic Remote pointer: moving over an element focuses it (mousemove, not
  // mouseover: content scrolling under a resting cursor must not steal focus).
  document.addEventListener("mousemove", (e) => {
    const el = (e.target as HTMLElement).closest?.("[data-f]") as HTMLElement | null;
    if (el && el !== current && scopeEl().contains(el)) focus(el);
  });
}
