// The first-load screen (four selectable styles) shown while a stream is
// prepared and until its first frame. Everything animates with transforms and
// opacity only (cheap on old TV GPUs); poster_reveal uses static CSS filters
// (rasterised once) and cross-fades between layers.
import { useEffect, useState, type ReactNode } from "react";
import type { PlaybackSource } from "@martytv/contracts";
import { placeholderColor } from "@martytv/media-types";
import { loadStatus, Mascot, PopcornLoader, SloganTicker, SovietEmblem, useAppliedDesign, useI18n } from "@martytv/ui";
import { Img, legacyColor } from "../components/Img";
import { formatBytes, formatSpeed } from "./format";
import { loadTracker, preloadTarget, type LoadStage } from "./loading";
import type { LoadingStyle } from "../profile/settings";

export interface LoaderModel {
  /** Monotonic 0..1. */
  p: number;
  stage: LoadStage;
  title: string;
  episode: string | null;
  poster: string | null;
  backdrop: string | null;
  /** Seed for placeholder colours. */
  seed: string;
  torrent: PlaybackSource["torrent"] | null;
  /** What is loading: «1080p · HDR · H.265 · Дубляж · 14,6 ГБ · RuTracker». */
  quality?: string | null;
  /** The file's size (the buffer goal when TorrServer reports none). */
  fileBytes?: number | null;
  /** The server converts audio / video for this TV (compat stream starting). */
  compat?: "audio" | "video" | null;
  /** Online source: no torrent numbers. */
  online?: boolean;
}

/** The first load's progress: one tracker for the app, so a remount (or a page restart) doesn't restart it. */
const tracker = loadTracker;

/**
 * Drives the tracker: recomputes every 400 ms (time-based creep inside a
 * stage) and whenever the stage/source changes. Never goes backwards within
 * one load (`loadKey`); a new load or another source starts from 0.
 */
export function useLoadProgress(
  loadKey: string,
  stage: LoadStage,
  source: Pick<PlaybackSource, "id" | "torrent" | "file" | "release"> | null,
  metadata: boolean,
  title?: string,
): number {
  const [p, setP] = useState(() => tracker.current(loadKey));
  useEffect(() => {
    const calc = () => setP(tracker.update(loadKey, { stage, source, sourceId: source?.id ?? null, metadata, title }, Date.now()));
    calc();
    if (stage === "done") return;
    const id = setInterval(calc, 400);
    return () => clearInterval(id);
  }, [loadKey, stage, source, metadata, title]);
  return p;
}

function useStatus(m: LoaderModel): { status: string; stats: string[] } {
  const { t, locale } = useI18n();
  const fmt = { bytes: (n: number) => formatBytes(n, locale), speed: (b: number) => formatSpeed(b, locale) };
  const { status, stats } = loadStatus(
    { stage: m.stage, torrent: m.torrent, target: preloadTarget(m.fileBytes ?? null), compat: m.compat ?? null, online: !!m.online },
    fmt,
  );
  return { status: t(status.key, status.vars), stats: stats.map((l) => t(l.key, l.vars)) };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** The loading screen in the chosen style. `preview` = settings thumbnail (no stats). */
export function Loader({ style, m, preview = false }: { style: LoadingStyle; m: LoaderModel; preview?: boolean }) {
  // «Конструктивизм»: one poster loader whatever the style (no mascot, no popcorn face) — the emblem and slogans.
  const cv = useAppliedDesign() === "constructivism" && !preview;
  const body = cv ? (
    <PosterLoader m={m} />
  ) : style === "popcorn" ? (
      <Popcorn m={m} />
    ) : style === "poster_reveal" ? (
      <PosterReveal m={m} />
    ) : style === "film_reel" ? (
      <FilmReel m={m} />
    ) : style === "minimal" ? (
      <Minimal m={m} />
    ) : style === "marty" || style === "marty_popcorn" ? (
      <MartyLoader m={m} mood={style === "marty_popcorn" ? "popcorn" : "loading"} />
    ) : (
      <FillTitle m={m} />
    );
  return (
    <div
      data-testid={preview ? "loader-preview" : "player-preparing"}
      data-loader={style}
      data-cv={cv ? "1" : undefined}
      data-progress={Math.round(m.p * 100)}
      className="tv-loader absolute left-0 top-0 h-full w-full overflow-hidden bg-bg"
    >
      {body}
    </div>
  );
}

function Status({ m, className = "" }: { m: LoaderModel; className?: string }) {
  const { status, stats } = useStatus(m);
  return (
    <div className={className}>
      <p data-testid="loader-status" className="text-4xl font-semibold">{status}</p>
      {m.quality && (
        <p data-testid="loader-quality" className="mt-4 truncate text-2xl font-semibold text-accent-strong">
          {m.quality}
        </p>
      )}
      {stats.length > 0 && (
        <p data-testid="loader-stats" className="mt-4 text-2xl tabular-nums text-muted">
          {stats.map((s, i) => (
            <span key={i}>
              {i > 0 && <span className="mx-3 opacity-50">·</span>}
              {s}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function Backdrop({ m, opacity }: { m: LoaderModel; opacity: number }) {
  return (
    <div className="absolute left-0 top-0 h-full w-full" style={{ opacity }}>
      <Img src={m.backdrop ?? m.poster} className="absolute left-0 top-0 h-full w-full object-cover" />
    </div>
  );
}

function PosterCard({ m, w, h, className = "", children }: { m: LoaderModel; w: number; h: number; className?: string; children?: ReactNode }) {
  return (
    <div className={`relative overflow-hidden rounded-3xl shadow-2xl ${className}`} style={{ width: w, height: h, background: legacyColor(placeholderColor(m.seed)) }}>
      <p className="absolute bottom-0 left-0 right-0 p-6 text-3xl font-semibold text-white">{m.title}</p>
      {children ?? <Img src={m.poster} className="absolute left-0 top-0 h-full w-full object-cover" />}
    </div>
  );
}

// ---------------------------------------------------------------- popcorn

/** The mascot's bucket fills with popcorn; title and status below. */
function Popcorn({ m }: { m: LoaderModel }) {
  const { status } = useStatus(m);
  return (
    <>
      <Backdrop m={m} opacity={0.18} />
      <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      <div className="absolute left-1/2 top-[110px] -translate-x-1/2">
        <PopcornLoader progress={m.p} size={440} label={`${status} ${pct(m.p)}`} />
      </div>
      <div className="absolute left-[160px] right-[160px] top-[640px] text-center">
        <h1 className="truncate text-6xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-2 truncate text-3xl text-muted">{m.episode}</p>}
        <div className="mt-8 flex items-start justify-center">
          <span className="mr-8 text-6xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
          <Status m={m} className="min-w-0 pt-1 text-left" />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- fill_title

/**
 * The title drawn as an outline, filled left→right with the accent colour.
 * The fill is a copy of the text inside a window that slides in from the
 * left while the copy slides the opposite way (two transforms = a moving
 * clip, no layout or repaint per frame).
 */
function FillTitle({ m }: { m: LoaderModel }) {
  const off = (1 - m.p) * 100;
  return (
    <>
      <Backdrop m={m} opacity={0.22} />
      <div className="tv-scrim-left absolute left-0 top-0 h-full w-full" />
      <div className="absolute left-[150px] top-1/2 -translate-y-1/2">
        <PosterCard m={m} w={400} h={600} className="tv-loader-float" />
      </div>
      <div className="absolute left-[650px] right-[120px] top-1/2 -translate-y-1/2">
        {m.episode && <p className="mb-6 truncate text-4xl text-muted">{m.episode}</p>}
        {/* Shrinks to the text, so the fill tracks the letters (not the column). */}
        <div className="relative inline-block max-w-full align-top">
          <h1 className="tv-loader-title tv-title-outline line-clamp-2">{m.title || "…"}</h1>
          <div className="tv-loader-ease absolute left-0 top-0 h-full w-full overflow-hidden" style={{ transform: `translate3d(${-off}%,0,0)` }}>
            <div className="tv-loader-ease h-full w-full" style={{ transform: `translate3d(${off}%,0,0)` }}>
              <h1 className="tv-loader-title line-clamp-2 text-accent">{m.title || "…"}</h1>
            </div>
            <span className="tv-fill-edge absolute right-0 top-0 h-full" />
          </div>
        </div>
        <div className="mt-14 flex items-end">
          <span className="w-[220px] shrink-0 text-7xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
          <Status m={m} className="min-w-0" />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- poster_reveal

let filterOk: boolean | null = null;
function supportsFilter(): boolean {
  if (filterOk !== null) return filterOk;
  try {
    const c = (window as unknown as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
    filterOk = !!c?.supports && (c.supports("filter", "blur(2px)") || c.supports("-webkit-filter", "blur(2px)"));
  } catch {
    filterOk = false;
  }
  return filterOk;
}

/**
 * The poster starts blurred and grey and sharpens into colour: three static
 * layers (grey+heavy blur, light blur, sharp colour) cross-faded by
 * progress. Without CSS filters: a dim poster fading to full colour.
 */
function PosterReveal({ m }: { m: LoaderModel }) {
  const filters = supportsFilter();
  const mid = Math.min(1, m.p * 1.8);
  const sharp = Math.max(0, Math.min(1, (m.p - 0.45) / 0.55));
  const W = 440;
  const H = 660;
  return (
    <>
      <Backdrop m={m} opacity={0.1} />
      <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      <div className="absolute left-1/2 top-[70px] -translate-x-1/2">
        <PosterCard m={m} w={W} h={H}>
          {m.poster && (
            <>
              <Img src={m.poster} className={`absolute left-0 top-0 h-full w-full object-cover ${filters ? "tv-reveal-blur" : "tv-reveal-dim"}`} />
              {filters && (
                <div className="tv-loader-fade absolute left-0 top-0 h-full w-full" style={{ opacity: mid }}>
                  <Img src={m.poster} className="tv-reveal-soft absolute left-0 top-0 h-full w-full object-cover" />
                </div>
              )}
              <div className="tv-loader-fade absolute left-0 top-0 h-full w-full" style={{ opacity: sharp }}>
                <Img src={m.poster} className="absolute left-0 top-0 h-full w-full object-cover" />
              </div>
            </>
          )}
        </PosterCard>
      </div>
      <div className="absolute left-[200px] right-[200px] text-center" style={{ top: 70 + H + 44 }}>
        <h1 className="truncate text-6xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-2 truncate text-3xl text-muted">{m.episode}</p>}
        <div className="mx-auto mt-8 flex w-[760px] items-center">
          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-text/15">
            <div className="tv-loader-ease absolute left-0 top-0 h-full w-full origin-left rounded-full bg-accent" style={{ transform: `scaleX(${m.p})` }} />
          </div>
          <span className="ml-6 w-[110px] text-left text-4xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
        </div>
        <Status m={m} className="mt-6 [&>p:first-child]:text-3xl" />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- film_reel

const FRAMES = 8;
const FRAME_W = 340;
const FRAME_GAP = 28;
const CELL = FRAME_W + FRAME_GAP;

/**
 * A film strip runs continuously across the screen; its frames light up one
 * by one with the artwork (panned frame to frame) as loading progresses (the frame being
 * "developed" pulses). The strip is two copies of the same frames so the
 * CSS animation loops seamlessly.
 */
function FilmReel({ m }: { m: LoaderModel }) {
  const lit = Math.floor(m.p * FRAMES + 0.0001);
  const img = m.backdrop ?? m.poster;
  const cells: ReactNode[] = [];
  for (let c = 0; c < FRAMES * 2; c++) {
    const i = c % FRAMES;
    const on = i < lit || m.p >= 1;
    const developing = i === lit && m.p < 1;
    cells.push(
      <div key={c} className="absolute top-0 h-full" style={{ left: c * CELL, width: CELL }}>
        <div className="tv-reel-holes absolute left-0 right-0 top-[10px] h-[20px]" />
        <div className="tv-reel-holes absolute bottom-[10px] left-0 right-0 h-[20px]" />
        <div
          className="absolute overflow-hidden rounded-lg"
          style={{ left: FRAME_GAP / 2, top: 44, width: FRAME_W, height: 212, background: legacyColor(placeholderColor(`${m.seed}${i}`)) }}
        >
          {img && (
            <div
              className={`tv-loader-fade absolute left-0 top-0 h-full w-full ${developing ? "tv-pulse" : ""}`}
              style={{
                opacity: on ? 1 : developing ? 0.55 : 0.1,
                // Each frame shows the artwork, panned a little further along the strip.
                backgroundImage: `url("${img}")`,
                backgroundSize: "cover",
                backgroundPosition: `${Math.round((i / (FRAMES - 1)) * 100)}% 50%`,
              }}
            />
          )}
          {!on && <div className="absolute left-0 top-0 h-full w-full bg-black/40" />}
        </div>
      </div>,
    );
  }
  return (
    <>
      <Backdrop m={m} opacity={0.12} />
      <div className="absolute left-[120px] right-[120px] top-[110px] text-center">
        <h1 className="truncate text-7xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-3 truncate text-4xl text-muted">{m.episode}</p>}
      </div>
      <div className="tv-reel absolute left-0 right-0 top-[360px] h-[300px] overflow-hidden">
        <div className="tv-reel-track absolute left-0 top-0 h-full" style={{ width: CELL * FRAMES * 2 }}>
          {cells}
        </div>
        <div className="tv-reel-gate absolute left-1/2 top-0 h-full w-[520px] -translate-x-1/2" />
      </div>
      <div className="absolute left-[120px] right-[120px] top-[720px] flex items-start justify-center">
        <span className="mr-10 text-7xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
        <Status m={m} className="min-w-0 pt-2" />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- minimal

/** Dimmed backdrop, the title, a thin accent line and the status. */
function Minimal({ m }: { m: LoaderModel }) {
  return (
    <>
      <Backdrop m={m} opacity={0.45} />
      <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      <div className="absolute bottom-[120px] left-[120px] right-[120px] flex items-end justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-7xl font-bold leading-tight">{m.title || "…"}</h1>
          {m.episode && <p className="mt-2 truncate text-4xl text-muted">{m.episode}</p>}
          <Status m={m} className="mt-8 [&>p:first-child]:text-3xl [&>p:first-child]:font-normal" />
        </div>
        <span className="ml-10 shrink-0 text-5xl font-semibold tabular-nums text-text/80">{pct(m.p)}</span>
      </div>
      <div className="absolute bottom-[64px] left-[120px] right-[120px] h-[6px] rounded-full bg-text/15">
        <div className="tv-loader-ease absolute left-0 top-0 h-full w-full origin-left rounded-full bg-accent" style={{ transform: `scaleX(${m.p})` }} />
        <div className="tv-loader-ease absolute left-0 top-0 h-full w-full" style={{ transform: `translate3d(${m.p * 1680}px,0,0)` }}>
          <span className="tv-line-head absolute -top-[7px] h-5 w-5 -translate-x-1/2 rounded-full bg-accent" />
        </div>
      </div>
    </>
  );
}

/** «Cineko»: the mascot's loading loop over the dimmed backdrop, a progress bar; he cheers at 100%. */
function MartyLoader({ m, mood }: { m: LoaderModel; mood: "loading" | "popcorn" }) {
  const done = m.p >= 0.999 || m.stage === "done";
  return (
    <>
      <Backdrop m={m} opacity={0.25} />
      <div className="absolute left-0 top-0 flex h-full w-full flex-col items-center justify-center px-[160px] text-center">
        <Mascot size={300} mood={done ? "happy" : mood} animated hat={null} />
        <h1 className="mt-6 max-w-[1500px] truncate text-6xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-2 truncate text-3xl text-muted">{m.episode}</p>}
        <div className="relative mt-10 h-[8px] w-[900px] rounded-full bg-text/15">
          <div className="tv-loader-ease absolute left-0 top-0 h-full w-full origin-left rounded-full bg-accent" style={{ transform: `scaleX(${m.p})` }} />
        </div>
        <Status m={m} className="mt-8 [&>p:first-child]:text-3xl [&>p:first-child]:font-normal" />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- «Конструктивизм»

/**
 * A 1920s poster: the hammer and sickle in a big red disc (a dashed ring
 * turns around it), the title in heavy capitals, a slogan that changes every
 * ~3.5 s on a tilted red slab, the percentage on a black diagonal band and a
 * thick red bar. Transforms and opacity only.
 */
function PosterLoader({ m }: { m: LoaderModel }) {
  const grot = "var(--mt-font-display)";
  return (
    <div data-testid="cv-loader" className="absolute left-0 top-0 h-full w-full">
      <Backdrop m={m} opacity={0.1} />
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <polygon points="0,1080 0,780 900,1080" fill="#d7261e" opacity=".85" />
        <line x1="980" y1="1080" x2="1920" y2="560" stroke="#efe4cc" strokeWidth="6" opacity=".18" />
      </svg>
      <div className="absolute" style={{ left: 1200, top: 120, width: 600, height: 600 }}>
        <div className="cvl-ring absolute left-0 top-0 h-full w-full rounded-full" />
        <div className="absolute rounded-full" style={{ left: 40, top: 40, width: 520, height: 520, background: "#d7261e" }} />
        <SovietEmblem size={380} bg={null} className="absolute" style={{ left: 110, top: 104 }} />
      </div>
      <div className="absolute left-[120px] top-[120px] w-[1020px]">
        <p className="text-[30px] font-bold uppercase tracking-[.3em] text-accent" style={{ fontFamily: grot }}>
          Киносеанс
        </p>
        <h1 className="mt-3 line-clamp-2 text-[96px] font-bold uppercase leading-[1.02] tracking-[.02em]" style={{ fontFamily: grot }}>
          {m.title || "…"}
        </h1>
        {m.episode && <p className="mt-3 truncate text-[36px] uppercase text-muted" style={{ fontFamily: grot }}>{m.episode}</p>}
        <div className="mt-10 origin-left" style={{ transform: "rotate(-3deg)" }}>
          <SloganTicker className="inline-block max-w-[1000px] bg-[#efe4cc] px-8 py-4 text-[48px] font-bold uppercase leading-[1.1] text-[#1a1512]" style={{ fontFamily: grot, height: 136 }} />
        </div>
      </div>
      <div className="absolute left-[-40px] top-[800px] flex h-[120px] w-[1100px] items-center bg-[#1a1512] pl-[160px]" style={{ transform: "rotate(-4deg)", transformOrigin: "0 50%" }}>
        <span className="text-[92px] font-bold tabular-nums leading-none text-[#efe4cc]" style={{ fontFamily: grot }}>
          {pct(m.p)}
        </span>
      </div>
      <div className="absolute bottom-[70px] left-[1160px] right-[120px]">
        <div className="relative h-[18px] bg-text/15">
          <div className="tv-loader-ease absolute left-0 top-0 h-full w-full origin-left bg-accent" style={{ transform: `scaleX(${m.p})` }} />
        </div>
        <Status m={m} className="mt-6 [&>p:first-child]:text-3xl [&>p:first-child]:uppercase" />
      </div>
    </div>
  );
}

/** Small looping spinner for re-buffering during playback (no overlay). */
export function BufferingSpinner() {
  return (
    <div data-testid="player-buffering" className="tv-buffering absolute left-1/2 top-1/2 flex h-24 w-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full">
      <span className="tv-spin block h-12 w-12 rounded-full" />
    </div>
  );
}
