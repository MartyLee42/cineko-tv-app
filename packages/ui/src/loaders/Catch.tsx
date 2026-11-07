// «Лови!»: a waiting game in an original LCD-handheld look (grey-green
// screen, ink segments with faint "ghost" positions). Cineko holds a basket
// at one of four chute ends; items (torrent pieces) roll down the chutes;
// the remote's arrows move the basket. A dropped one cracks with a soft
// «хрусь» (only with «Звуки интерфейса» on). The big number is the load's
// percentage; the game never holds playback back.
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { playLoaderSound } from "../uiSoundsAudio";
import type { SoundRecipe } from "../uiSounds";
import { ArtBox, At, type ArtProps } from "./parts";
import { CRACK_MS, itemStep, LANES, laneLevel, laneSide, moveBasket, newGame, stepGame, STEPS, type Game, type Lane } from "./catchGame";

export type CatchKey = "left" | "right" | "up" | "down";

/** A soft «хрусь»: a short filtered noise crunch and a tiny falling blip. */
export const CRUNCH: SoundRecipe = {
  tones: [{ wave: "triangle", from: 420, to: 180, at: 0, dur: 0.09, gain: 0.25 }],
  noise: [
    { filter: "bandpass", freq: 2400, q: 1.2, at: 0, dur: 0.05, gain: 0.5 },
    { filter: "bandpass", freq: 1600, q: 1.5, at: 0.045, dur: 0.06, gain: 0.35 },
  ],
};

const CSS = `
.ld-lcd { background: #c4d0aa; box-shadow: inset 0 0 0 6px #aab78f, inset 0 8px 24px rgba(0,0,0,.18); }
.ld-ink { color: #182012; }
.ld-crack { animation: ld-crack .25s ease-out both; }
@keyframes ld-crack { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: scale(1); } }
`;

const INK = "#182012";
const GHOST = "rgba(24,32,18,.09)";
// The LCD (art px) and the chutes inside it.
const SX = 170;
const SY = 40;
const SW = 860;
const SH = 470;

/** Item position (LCD px) at a step of a lane's chute. */
function spot(lane: Lane, step: number): { x: number; y: number } {
  const left = laneSide(lane) === "left";
  const y0 = laneLevel(lane) === "top" ? 120 : 270;
  const x = 70 + step * 52;
  return { x: left ? x : SW - x, y: y0 + step * 24 };
}

function Reel({ color }: { color: string }) {
  return (
    <svg width="34" height="40" viewBox="0 0 34 40" aria-hidden>
      {/* a tiny film reel: a piece of the film */}
      <circle cx="17" cy="21" r="15" fill={color} />
      <g fill="#c4d0aa" opacity={color === INK ? 1 : 0}>
        <circle cx="17" cy="13" r="3.6" />
        <circle cx="24.6" cy="18.5" r="3.6" />
        <circle cx="21.7" cy="27.5" r="3.6" />
        <circle cx="12.3" cy="27.5" r="3.6" />
        <circle cx="9.4" cy="18.5" r="3.6" />
      </g>
    </svg>
  );
}

function CrackGlyph() {
  return (
    <svg width="70" height="40" viewBox="0 0 70 40" aria-hidden>
      <path d="M6 34 L16 20 L22 28 L28 16 L34 34 Z" fill={INK} />
      <path d="M38 34 L44 18 L50 26 L58 14 L64 34 Z" fill={INK} />
      <ellipse cx="35" cy="36" rx="30" ry="4" fill={INK} opacity=".35" />
    </svg>
  );
}

/** Cineko in ink with a basket at one of the four positions (ghost poses faint). */
function Catcher({ at }: { at: Lane }) {
  return (
    <svg width="360" height="300" viewBox="0 0 360 300" aria-hidden>
      {/* the four basket positions: arms + basket, active one in ink */}
      {LANES.map((l) => {
        const left = laneSide(l) === "left";
        const top = laneLevel(l) === "top";
        const c = l === at ? INK : GHOST;
        const bx = left ? 18 : 262;
        const by = top ? 60 : 200;
        const hx = left ? 120 : 240;
        return (
          <g key={l} fill={c} stroke={c}>
            <path d={`M${hx} 170 L${left ? bx + 70 : bx + 10} ${by + 18}`} strokeWidth="14" strokeLinecap="round" fill="none" />
            <path d={`M${bx} ${by} L${bx + 80} ${by} L${bx + 68} ${by + 44} L${bx + 12} ${by + 44} Z`} stroke="none" />
            <path d={`M${bx + 6} ${by + 10} L${bx + 74} ${by + 10} M${bx + 10} ${by + 24} L${bx + 70} ${by + 24}`} stroke={l === at ? "#c4d0aa" : "none"} strokeWidth="4" />
          </g>
        );
      })}
      {/* body + head (always ink) */}
      <path d="M130 290 L130 200 Q180 170 230 200 L230 290 Z" fill={INK} />
      <path d="M128 92 L138 38 L166 70 Z M232 92 L222 38 L194 70 Z" fill={INK} />
      <ellipse cx="180" cy="120" rx="62" ry="54" fill={INK} />
      <rect x="175" y="52" width="10" height="14" fill={INK} />
      <circle cx="180" cy="48" r="7" fill={INK} />
      <ellipse cx="158" cy="116" rx="11" ry="14" fill="#c4d0aa" />
      <ellipse cx="202" cy="116" rx="11" ry="14" fill="#c4d0aa" />
      <path d="M168 148 Q174 154 180 148 Q186 154 192 148" stroke="#c4d0aa" strokeWidth="4" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The game loop: ticks while shown, items follow progress. `bindKeys`
 * connects the host's arrows (TV: the player's key handler while loading;
 * web: the window) and returns the unbinding.
 */
export function useCatchGame(p: number, opts: { live: boolean; quiet?: boolean; auto?: boolean; bindKeys?: (move: (k: CatchKey) => void) => () => void }) {
  const [basket, setBasket] = useState<Lane>(1);
  const [view, setView] = useState<{ game: Game; now: number } | null>(null);
  const pRef = useRef(p);
  const basketRef = useRef(basket);
  useEffect(() => {
    pRef.current = p;
    basketRef.current = basket;
  });
  const { live, quiet, auto, bindKeys } = opts;
  useEffect(() => {
    if (!live) return;
    const tick = () =>
      setView((v) => {
        const now = Date.now();
        const g = v?.game ?? newGame(now, pRef.current, now);
        const r = stepGame(g, now, pRef.current, auto && g.items.length ? g.items[0]!.lane : basketRef.current);
        if (!quiet && r.events.some((e) => e.kind === "miss")) playLoaderSound(CRUNCH);
        return { game: r.game, now };
      });
    tick();
    const id = setInterval(tick, 130);
    return () => clearInterval(id);
  }, [live, quiet, auto]);
  useEffect(() => {
    if (!bindKeys) return;
    return bindKeys((k) => setBasket((b) => moveBasket(b, k)));
  }, [bindKeys]);
  return { game: view?.game ?? null, now: view?.now ?? 0, basket };
}

export function CatchArt({
  p,
  width,
  calm,
  done,
  quiet,
  label,
  bindKeys,
  demo,
}: ArtProps & { label?: string; bindKeys?: (move: (k: CatchKey) => void) => () => void; demo?: boolean }) {
  const { t } = useI18n();
  const { game, now, basket } = useCatchGame(p, { live: !done, quiet: quiet || demo, auto: demo, bindKeys });
  // Previews: the basket follows the oldest item by itself.
  const shownBasket = demo && game?.items.length ? game.items[0]!.lane : basket;
  const pctText = `${done ? 100 : Math.floor(Math.max(0, Math.min(0.999, p)) * 100)}`;
  return (
    <ArtBox width={width} calm={calm} css={CSS} label={label}>
      {/* the handheld */}
      <At x={110} y={0} w={980} h={560} style={{ borderRadius: 48, background: "linear-gradient(160deg, #e9e3d3, #cfc6b0)", boxShadow: "0 18px 40px rgba(0,0,0,.45), inset 0 -6px 0 rgba(0,0,0,.12)" }} />
      <At x={SX} y={SY} w={SW} h={SH} className="ld-lcd" style={{ borderRadius: 18, overflow: "hidden" }}>
        {/* chutes (ink rails) */}
        <svg width={SW} height={SH} viewBox={`0 0 ${SW} ${SH}`} style={{ position: "absolute", left: 0, top: 0 }} aria-hidden>
          {LANES.map((l) => {
            const a = spot(l, 0);
            const b = spot(l, STEPS - 1);
            const left = laneSide(l) === "left";
            return <path key={l} d={`M${left ? 20 : SW - 20} ${a.y + 4} L${b.x + (left ? 30 : -30)} ${b.y + 30}`} stroke={INK} strokeWidth="6" strokeLinecap="round" opacity=".8" />;
          })}
          {/* the floor */}
          <path d={`M20 ${SH - 26} L${SW - 20} ${SH - 26}`} stroke={INK} strokeWidth="4" opacity=".5" strokeDasharray="10 8" />
        </svg>
        {/* ghost segments of every item position, then the live ones */}
        {LANES.map((l) =>
          Array.from({ length: STEPS }, (_, s) => {
            const q = spot(l, s);
            return (
              <At key={`g${l}-${s}`} x={q.x - 17} y={q.y - 30} w={34} h={40}>
                <Reel color={GHOST} />
              </At>
            );
          }),
        )}
        {game?.items.map((it) => {
          const s = Math.min(STEPS - 1, itemStep(it, now || it.born));
          const q = spot(it.lane, s);
          return (
            <At key={it.id} x={q.x - 17} y={q.y - 30} w={34} h={40}>
              <Reel color={INK} />
            </At>
          );
        })}
        {game?.cracks.map((c) => {
          const left = laneSide(c.lane) === "left";
          return (
            <At key={`${c.lane}-${c.at}`} x={left ? 250 : SW - 320} y={SH - 64} w={70} h={40} className="ld-crack" style={{ opacity: now - c.at < CRACK_MS ? 1 : 0 }}>
              <CrackGlyph />
            </At>
          );
        })}
        {/* Cineko and the basket */}
        <At x={SW / 2 - 180} y={SH - 300} w={360} h={300}>
          <Catcher at={shownBasket} />
        </At>
        {/* the big percentage and the catch counter, LCD digits */}
        <At x={0} y={14} w={SW} h={90} style={{ textAlign: "center", fontFamily: "'Pixelify Sans', 'JetBrains Mono', ui-monospace, monospace", color: INK }}>
          <span style={{ fontSize: 78, fontWeight: 700, lineHeight: "84px" }}>{pctText}</span>
          <span style={{ fontSize: 40, fontWeight: 700, marginLeft: 6 }}>%</span>
        </At>
        <At x={SW - 250} y={22} w={230} h={40} style={{ textAlign: "right", fontFamily: "'Pixelify Sans', 'JetBrains Mono', ui-monospace, monospace", fontSize: 28, fontWeight: 700, color: INK }}>
          {t("loaders.catch.caught", { n: game?.caught ?? 0 })}
        </At>
        {done && (
          <At x={SW / 2 - 260} y={SH / 2 - 70} w={520} h={110} style={{ background: INK, color: "#c4d0aa", borderRadius: 14, textAlign: "center", fontFamily: "'Pixelify Sans', 'JetBrains Mono', ui-monospace, monospace", fontSize: 54, fontWeight: 700, lineHeight: "110px" }}>
            {t("loaders.catch.caught", { n: game?.caught ?? 0 })}
          </At>
        )}
      </At>
      {/* the case: three pill keys under the screen (decoration) */}
      {[530, 585, 640].map((x) => (
        <At key={x} x={x} y={522} w={40} h={16} style={{ borderRadius: 8, background: "#8f8676", boxShadow: "inset 0 -2px 0 rgba(0,0,0,.25)" }} />
      ))}
    </ArtBox>
  );
}
