import { useEffect } from "react";

// Stops the page behind a modal from scrolling. Nested modals share one lock;
// the page gets its old styles and scroll position back when the last one
// closes.
//
// The body is pinned (`position: fixed`, shifted up by the scroll offset)
// rather than only `overflow: hidden` on <html>: WebKit (every iPad / iPhone
// browser) doesn't keep the root's scroll position under `overflow: hidden`,
// so the page behind the sheet jumped to the top and back again on close.

type Style = Record<"overflow" | "overscrollBehavior" | "position" | "top" | "left" | "right" | "width", string>;
export type ScrollDoc = {
  documentElement: { style: Pick<Style, "overflow"> };
  body: { style: Style };
};
export type ScrollWin = { scrollX: number; scrollY: number; scrollTo: (opts: ScrollToOptions) => void };

const KEYS = ["overflow", "overscrollBehavior", "position", "top", "left", "right", "width"] as const;

let holders = 0;
let saved: { html: string; body: Partial<Style>; x: number; y: number } | null = null;

export function lockScroll(doc: ScrollDoc = document as unknown as ScrollDoc, win: ScrollWin = window): () => void {
  const html = doc.documentElement;
  const body = doc.body;
  if (holders++ === 0) {
    const x = win.scrollX;
    const y = win.scrollY;
    const prev: Partial<Style> = {};
    for (const k of KEYS) prev[k] = body.style[k];
    saved = { html: html.style.overflow, body: prev, x, y };
    html.style.overflow = "hidden";
    Object.assign(body.style, {
      overflow: "hidden",
      overscrollBehavior: "none",
      position: "fixed",
      top: `${-y}px`,
      left: `${-x}px`,
      right: "0",
      width: "100%",
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0 && saved) {
      const s = saved;
      saved = null;
      html.style.overflow = s.html;
      for (const k of KEYS) body.style[k] = s.body[k] ?? "";
      // Back where the page was, at once (never a smooth scroll from the top).
      win.scrollTo({ left: s.x, top: s.y, behavior: "instant" as ScrollBehavior });
    }
  };
}

export function useScrollLock(active = true) {
  useEffect(() => (active ? lockScroll() : undefined), [active]);
}
