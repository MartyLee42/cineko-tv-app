import { useEffect } from "react";

/** Freezes the page behind an overlay (no scrolling or bounce of the page underneath). */
export function useScrollLock() {
  useEffect(() => {
    const html = document.documentElement;
    const prev = [html.style.overflow, document.body.style.overflow];
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prev[0]!;
      document.body.style.overflow = prev[1]!;
    };
  }, []);
}
