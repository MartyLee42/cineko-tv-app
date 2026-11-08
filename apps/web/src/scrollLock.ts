import { useEffect } from "react";

// Stops the page behind a modal from scrolling. Nested modals share one lock;
// the page gets its old styles back when the last one closes.
let holders = 0;
let saved: { html: string; body: string; overscroll: string } | null = null;

type Doc = { documentElement: { style: { overflow: string } }; body: { style: { overflow: string; overscrollBehavior: string } } };

export function lockScroll(doc: Doc = document): () => void {
  const html = doc.documentElement;
  const body = doc.body;
  if (holders++ === 0) {
    saved = { html: html.style.overflow, body: body.style.overflow, overscroll: body.style.overscrollBehavior };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0 && saved) {
      html.style.overflow = saved.html;
      body.style.overflow = saved.body;
      body.style.overscrollBehavior = saved.overscroll;
      saved = null;
    }
  };
}

export function useScrollLock(active = true) {
  useEffect(() => (active ? lockScroll() : undefined), [active]);
}
