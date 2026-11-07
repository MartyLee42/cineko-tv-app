// «Красная комната»: a homage to a famous surreal TV series' red room (original drawings only,
// no characters or logos). Red curtains frame the screen, a black-and-white zigzag floor runs
// along the bottom, a cup of coffee and a slice of cherry pie stand at the curtains' feet (the
// frame sits over the content, under the menu, like Тамагочи's shell). Sometimes a focused
// card's title plays backwards for a moment (design/backwards.ts; off in calm motion).
import "./redroom.css";
import { useEffect } from "react";
import type { Look } from "./types";
import { layer } from "./common";
import { BACKWARDS_MS, playsBackwards } from "../backwards";

const CURTAIN_W = 78;
const FLOOR_H = 50;

/** A curtain's inner edge: gentle scallops down the drop (x offsets from the curtain's edge). */
function curtainPath(side: "l" | "r"): string {
  const pts: string[] = [];
  for (let y = 0; y <= 1080; y += 60) {
    const k = (y / 60) % 2 ? 0 : 7;
    pts.push(`${side === "l" ? CURTAIN_W - k : 1920 - CURTAIN_W + k} ${y}`);
  }
  return side === "l" ? `M0 0 L${pts.join(" L")} L0 1080 Z` : `M1920 0 L${pts.join(" L")} L1920 1080 Z`;
}
const CURTAIN_L = curtainPath("l");
const CURTAIN_R = curtainPath("r");

/** The valance: a row of swags along the top. */
const VALANCE = (() => {
  let d = "M0 0 L1920 0 L1920 26";
  for (let x = 1920; x > 0; x -= 120) d += ` Q ${x - 60} 58 ${x - 120} 26`;
  return `${d} Z`;
})();

/** A cup of coffee on a saucer, with a curl of steam (~70 px wide; origin at the saucer's centre). */
function Coffee({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(1.2)`}>
      <path d="M-14 -40 C -20 -48 -8 -54 -14 -62 M0 -42 C -6 -52 6 -58 0 -68" fill="none" stroke="rgba(240,236,228,.55)" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="0" cy="2" rx="34" ry="8" fill="#e9e4da" stroke="#1a0b0b" strokeWidth="2" />
      <path d="M-22 -30 L22 -30 L18 -4 C 16 2 -16 2 -18 -4 Z" fill="#f4efe6" stroke="#1a0b0b" strokeWidth="2" strokeLinejoin="round" />
      <path d="M21 -24 C 34 -24 34 -10 19 -10" fill="none" stroke="#f4efe6" strokeWidth="5" />
      <ellipse cx="0" cy="-30" rx="22" ry="5" fill="#2a160c" stroke="#1a0b0b" strokeWidth="2" />
    </g>
  );
}

/** A slice of cherry pie on a plate: a golden crust wedge, a lattice and cherries. */
function Pie({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(1.2)`}>
      <ellipse cx="0" cy="2" rx="38" ry="9" fill="#e9e4da" stroke="#1a0b0b" strokeWidth="2" />
      <path d="M-30 -2 L30 -2 L26 -16 L-26 -16 Z" fill="#a8121c" stroke="#1a0b0b" strokeWidth="2" strokeLinejoin="round" />
      <path d="M-26 -16 L26 -16 L-4 -40 Z" fill="#d9a24e" stroke="#1a0b0b" strokeWidth="2" strokeLinejoin="round" />
      <path d="M-14 -16 L4 -30 M2 -16 L12 -24 M-10 -26 L14 -20" stroke="#a8742c" strokeWidth="3" strokeLinecap="round" />
      <circle cx="-16" cy="-8" r="4" fill="#e3263a" />
      <circle cx="0" cy="-9" r="4" fill="#e3263a" />
      <circle cx="16" cy="-8" r="4" fill="#e3263a" />
    </g>
  );
}

/** The room's frame over the content: two curtains, the valance, the zigzag floor, coffee and pie. Static. */
function Frame() {
  return (
    <svg data-skin-bg-frame className={`${layer} rr-frame`} width={1920} height={1080} viewBox="0 0 1920 1080" aria-hidden>
      <defs>
        <linearGradient id="rr-fold" x1="0" y1="0" x2="26" y2="0" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
          <stop offset="0" stopColor="#4a0306" />
          <stop offset="0.35" stopColor="#b3121c" />
          <stop offset="0.55" stopColor="#d21f2a" />
          <stop offset="1" stopColor="#4a0306" />
        </linearGradient>
        <linearGradient id="rr-shade-l" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="rgba(0,0,0,0)" />
          <stop offset="1" stopColor="rgba(0,0,0,.45)" />
        </linearGradient>
        <linearGradient id="rr-shade-r" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="rgba(0,0,0,0)" />
          <stop offset="1" stopColor="rgba(0,0,0,.45)" />
        </linearGradient>
        <pattern id="rr-zig" x="0" y={1080 - FLOOR_H} width="50" height="25" patternUnits="userSpaceOnUse">
          <rect width="50" height="25" fill="#0d0b0b" />
          <path d="M0 0 L25 12.5 L50 0 L50 12.5 L25 25 L0 12.5 Z" fill="#ece7dd" />
        </pattern>
      </defs>
      <rect x="0" y={1080 - FLOOR_H} width="1920" height={FLOOR_H} fill="url(#rr-zig)" />
      <rect x="0" y={1080 - FLOOR_H} width="1920" height="4" fill="rgba(0,0,0,.6)" />
      <path d={CURTAIN_L} fill="url(#rr-fold)" />
      <path d={CURTAIN_L} fill="url(#rr-shade-l)" />
      <path d={CURTAIN_R} fill="url(#rr-fold)" />
      <path d={CURTAIN_R} fill="url(#rr-shade-r)" />
      <path d={VALANCE} fill="url(#rr-fold)" />
      <path d={VALANCE} fill="rgba(0,0,0,.18)" transform="translate(0 4)" opacity=".6" />
      <Pie x={46} y={1064} />
      <Coffee x={1876} y={1064} />
    </svg>
  );
}

// ================================================================ «sometimes plays backwards»

const seen = new Set<string>();
let last = 0;

/** The title line of a focused card: the projector's wide card prints it on the image, posters under it. */
function titleOf(card: Element): HTMLElement | null {
  const wrap = card.closest("[data-card-id]");
  const scan = (el: Element | null) => {
    for (let c = el ? el.firstElementChild : null; c; c = c.nextElementSibling) if (c.tagName === "P" && c.classList.contains("truncate")) return c as HTMLElement;
    return null;
  };
  return scan(card) ?? scan(wrap);
}

/** After an arrow key lands focus on a card, maybe mirror its title for a moment. */
function useBackwards(calm: boolean) {
  useEffect(() => {
    if (calm) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.keyCode < 37 || e.keyCode > 40) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.documentElement.classList.contains("mt-fast")) return;
        const card = document.querySelector(".mt-card.is-focused");
        const wrap = card ? card.closest("[data-card-id]") : null;
        const title = card ? titleOf(card) : null;
        if (!card || !title) return;
        const id = wrap ? wrap.getAttribute("data-card-id") : null;
        const now = Date.now();
        if (!playsBackwards({ id, text: title.textContent ?? "", seen, now, last })) return;
        seen.add(id!);
        last = now;
        title.classList.add("rr-backwards");
        setTimeout(() => title.classList.remove("rr-backwards"), BACKWARDS_MS + 40);
      }, 120);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [calm]);
}

/** Behind the content: the room's back wall (dim curtain folds); over it, the frame. */
function Room({ calm, dim }: { calm: boolean; dim: boolean }) {
  useBackwards(calm);
  return (
    <>
      <div data-skin-bg="curtains" className={`rr-wall ${dim ? "rr-wall-dim" : ""} ${layer}`} />
      <Frame />
    </>
  );
}

/** Over Home's artwork: the red room's light falling off towards the edges. */
function RoomHeroEdges() {
  return <div className="rr-vignette pointer-events-none absolute left-0 top-0 h-full w-full" />;
}

export const look: Look = { Background: Room, HeroEdges: RoomHeroEdges };
