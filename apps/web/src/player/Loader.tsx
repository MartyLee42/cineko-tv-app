// First-load screen of the in-browser player, in the profile's loading style.
// Progress is real: source creation → torrent metadata → preloaded bytes →
// the video's metadata/canplay (see logic.ts). Later re-buffering only shows
// a small spinner (Player).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PlaybackSource } from "@martytv/contracts";
import { placeholderColor } from "@martytv/media-types";
import { loadStatus, Mascot, SloganTicker, SovietEmblem, useAppliedDesign, useI18n } from "@martytv/ui";
import { PopcornLoader } from "@martytv/ui/popcorn";
import { formatSize, formatSpeed } from "../play/releases";
import type { LoadingStyle } from "../watch/settings";
import { LoadTracker, preloadTarget, type LoadStage } from "./logic";
import "../matrix/matrix.css";

export interface LoaderModel {
  p: number;
  stage: LoadStage;
  title: string;
  subtitle: string | null;
  poster: string | null;
  backdrop: string | null;
  torrent: PlaybackSource["torrent"] | null;
  /** What is loading: «1080p · HDR · H.265 · Дубляж · 14,6 ГБ». */
  quality?: string | null;
  /** The file's size (the buffer goal when TorrServer reports none). */
  fileBytes?: number | null;
  /** Online source: no torrent numbers. */
  online?: boolean;
}

/**
 * Monotonic progress, recomputed every 400 ms (time-based creep inside a
 * stage). One tracker per Watch instance — WatchPage keys it per attempt, so a
 * new attempt (another release) starts from 0; another source id resets too.
 */
export function useLoadProgress(stage: LoadStage, source: Pick<PlaybackSource, "id" | "torrent" | "file" | "release"> | null, metadata: boolean): number {
  const [p, setP] = useState(0);
  const tracker = useRef<LoadTracker | null>(null);
  useEffect(() => {
    const tr = (tracker.current ??= new LoadTracker());
    const calc = () => setP(tr.update({ stage, source, sourceId: source?.id ?? null, metadata }, Date.now()));
    const first = setTimeout(calc, 0);
    if (stage === "done") return () => clearTimeout(first);
    const id = setInterval(calc, 400);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [stage, source, metadata]);
  return p;
}

function useStatus(m: LoaderModel): { status: string; stats: string[] } {
  const { t, locale } = useI18n();
  const fmt = { bytes: (n: number) => formatSize(n, locale), speed: (b: number) => formatSpeed(b, locale) };
  const st = loadStatus({ stage: m.stage, torrent: m.torrent, target: preloadTarget(m.fileBytes ?? null), online: !!m.online }, fmt);
  // Web resolves the release for this browser first (its own wording).
  const status = m.stage === "resolving" ? t("player.web.loading.resolving") : t(st.status.key, st.status.vars);
  return { status, stats: st.stats.map((l) => t(l.key, l.vars)) };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function Loader({ style, m, children }: { style: LoadingStyle; m: LoaderModel; children?: ReactNode }) {
  // «Конструктивизм»: one poster loader whatever the style — no mascot; the emblem and changing slogans.
  const applied = useAppliedDesign();
  const cv = applied === "constructivism";
  // «Матрица»: its own terminal loader too.
  const mx = applied === "matrix" || style === "matrix";
  const body = cv ? (
    <PosterLoader m={m} />
  ) : mx ? (
    <MatrixLoader m={m} />
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
      data-testid="player-loader"
      data-loader={style}
      data-cv={cv ? "1" : undefined}
      data-stage={m.stage}
      data-progress={Math.round(m.p * 100)}
      className="fixed inset-0 z-10 overflow-hidden bg-bg text-text"
    >
      <Backdrop m={m} />
      <div className="relative flex h-full w-full flex-col items-center justify-center px-[max(env(safe-area-inset-left),1.25rem)] pb-[max(env(safe-area-inset-bottom),1rem)] pt-[max(env(safe-area-inset-top),3.5rem)]">
        {body}
      </div>
      {children}
    </div>
  );
}

function Backdrop({ m }: { m: LoaderModel }) {
  const src = m.backdrop ?? m.poster;
  return (
    <div className="absolute inset-0" aria-hidden>
      {src && <img src={src} alt="" className="h-full w-full object-cover opacity-25 blur-[2px]" />}
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/80 to-bg/40" />
    </div>
  );
}

function Status({ m, center = true }: { m: LoaderModel; center?: boolean }) {
  const { status, stats } = useStatus(m);
  return (
    <div className={center ? "text-center" : ""} aria-live="polite">
      <p className="text-sm font-semibold sm:text-base" data-testid="player-loader-status">
        {status}
      </p>
      {m.quality && (
        <p className="mt-1 truncate text-xs font-semibold text-accent-strong sm:text-sm" data-testid="player-loader-quality">
          {m.quality}
        </p>
      )}
      {stats.length > 0 && (
        <p className="mt-1 text-xs tabular-nums text-muted sm:text-sm" data-testid="player-loader-stats">
          {stats.join(" · ")}
        </p>
      )}
    </div>
  );
}

function Titles({ m, className = "" }: { m: LoaderModel; className?: string }) {
  return (
    <div className={`min-w-0 max-w-full text-center ${className}`}>
      <h1 className="line-clamp-2 font-display text-2xl font-extrabold leading-tight sm:text-4xl">{m.title || "…"}</h1>
      {m.subtitle && <p className="mt-1 truncate text-sm text-muted sm:text-base">{m.subtitle}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- styles

function Popcorn({ m }: { m: LoaderModel }) {
  const { status } = useStatus(m);
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-4 landscape:max-h-full">
      <div className="h-[min(42vw,32vh,260px)] w-[min(42vw,32vh,260px)] shrink-0">
        <PopcornLoader progress={m.p} size={260} className="h-full w-full" label={`${status} ${pct(m.p)}`} />
      </div>
      <Titles m={m} />
      <div className="flex items-center gap-4">
        <span className="font-display text-3xl font-extrabold tabular-nums text-accent sm:text-4xl">{pct(m.p)}</span>
        <Status m={m} center={false} />
      </div>
    </div>
  );
}

function FillTitle({ m }: { m: LoaderModel }) {
  const fill = Math.round(m.p * 100);
  return (
    <div className="flex w-full max-w-3xl flex-col items-center gap-6">
      {m.subtitle && <p className="truncate text-sm text-muted sm:text-base">{m.subtitle}</p>}
      <h1
        className="line-clamp-3 max-w-full text-center font-display text-4xl font-black uppercase leading-[0.95] tracking-tight transition-[background-position] duration-500 sm:text-6xl"
        style={{
          backgroundImage: `linear-gradient(90deg, rgb(var(--mt-accent)) ${fill}%, rgba(var(--mt-text), 0.18) ${fill}%)`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        {m.title || "…"}
      </h1>
      <div className="flex items-center gap-4">
        <span className="font-display text-3xl font-extrabold tabular-nums text-accent">{pct(m.p)}</span>
        <Status m={m} center={false} />
      </div>
    </div>
  );
}

function PosterReveal({ m }: { m: LoaderModel }) {
  const blur = (1 - m.p) * 14;
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-5">
      <div
        className="relative aspect-[2/3] h-[min(46vh,22rem)] overflow-hidden rounded-2xl shadow-2xl shadow-black/40"
        style={{ background: placeholderColor(m.title) }}
      >
        {m.poster && (
          <img
            src={m.poster}
            alt=""
            className="h-full w-full object-cover transition-[filter] duration-500"
            style={{ filter: `blur(${blur.toFixed(1)}px) grayscale(${(1 - m.p).toFixed(2)})` }}
          />
        )}
      </div>
      <Titles m={m} />
      <Bar p={m.p} />
      <Status m={m} />
    </div>
  );
}

function FilmReel({ m }: { m: LoaderModel }) {
  const frames = 8;
  const lit = Math.floor(m.p * frames + 1e-9);
  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-6">
      <Titles m={m} />
      <div className="w-full rounded-xl bg-black/70 px-2 py-2 shadow-xl">
        <div className="mb-1.5 h-1.5 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,.35)_0_8px,transparent_8px_16px)]" />
        <div className="flex gap-1.5">
          {Array.from({ length: frames }, (_, i) => (
            <span key={i} className={`h-10 flex-1 rounded-sm transition-colors duration-500 sm:h-14 ${i < lit ? "bg-accent" : "bg-white/10"}`} />
          ))}
        </div>
        <div className="mt-1.5 h-1.5 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,.35)_0_8px,transparent_8px_16px)]" />
      </div>
      <div className="flex items-center gap-4">
        <span className="font-display text-3xl font-extrabold tabular-nums text-accent">{pct(m.p)}</span>
        <Status m={m} center={false} />
      </div>
    </div>
  );
}

function Minimal({ m }: { m: LoaderModel }) {
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-5">
      <Titles m={m} />
      <Bar p={m.p} />
      <Status m={m} />
    </div>
  );
}

/** «Cineko»: the mascot's loading loop, a bar; he cheers at 100%. */
function MartyLoader({ m, mood }: { m: LoaderModel; mood: "loading" | "popcorn" }) {
  const done = m.p >= 0.999 || m.stage === "done";
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-5" data-testid="loader-marty">
      <Mascot size={160} mood={done ? "happy" : mood} animated hat={null} />
      <Titles m={m} />
      <Bar p={m.p} />
      <Status m={m} />
    </div>
  );
}

/** «Конструктивизм»: the hammer and sickle in a red disc, the title in heavy capitals, a slogan slab that changes every ~3.5 s. */
const MX_CELLS = 20;

/** «Матрица»: «> Loading construct…», the percentage counting up in green and a block bar. */
function MatrixLoader({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const filled = Math.round(m.p * MX_CELLS);
  return (
    <div data-testid="mx-loader" className="mx-wake w-full max-w-xl px-5 py-6 text-left" style={{ background: "rgba(0,6,2,.86)", boxShadow: "inset 0 0 0 1px rgba(0,255,65,.45), 0 0 40px rgba(0,255,65,.15)" }}>
      <p className="text-sm sm:text-base">
        {"> "}
        {t("designs.matrix.loading")}
        <i aria-hidden />
      </p>
      <h1 className="mt-4 line-clamp-2 text-2xl font-bold uppercase leading-tight sm:text-3xl" style={{ color: "#c8ffd2" }}>
        {m.title || "…"}
      </h1>
      {m.subtitle && <p className="mt-1 truncate text-sm text-muted">{m.subtitle}</p>}
      <div className="mt-6 flex items-baseline gap-4">
        <span className="w-[4.5ch] text-4xl font-bold tabular-nums sm:text-5xl" style={{ textShadow: "0 0 18px rgba(0,255,65,.7)" }}>
          {pct(m.p)}
        </span>
        <span className="whitespace-pre text-lg leading-none sm:text-xl" aria-hidden>
          {"█".repeat(filled)}
          <span style={{ color: "rgba(0,255,65,.22)" }}>{"░".repeat(MX_CELLS - filled)}</span>
        </span>
      </div>
      <div className="mt-5 text-text">
        <Status m={m} center={false} />
      </div>
    </div>
  );
}

function PosterLoader({ m }: { m: LoaderModel }) {
  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-5" data-testid="cv-loader">
      <div className="relative h-[min(46vw,28vh,240px)] w-[min(46vw,28vh,240px)] shrink-0">
        <span className="cv-ring absolute -inset-3 rounded-full" aria-hidden />
        <SovietEmblem size={0} className="h-full w-full" />
      </div>
      <div className="min-w-0 max-w-full text-center">
        <p className="font-display text-xs font-bold uppercase tracking-[0.3em] text-accent sm:text-sm">Киносеанс</p>
        <h1 className="line-clamp-2 font-display text-3xl font-bold uppercase leading-[1.02] sm:text-5xl">{m.title || "…"}</h1>
        {m.subtitle && <p className="mt-1 truncate text-sm uppercase text-muted sm:text-base">{m.subtitle}</p>}
      </div>
      <div className="w-full max-w-xl -rotate-2">
        <SloganTicker className="cv-slogan-slab h-[4.6rem] bg-[#efe4cc] px-4 py-2.5 text-center font-display text-xl font-bold uppercase leading-tight text-[#1a1512] sm:h-[5.2rem] sm:text-2xl" />
      </div>
      <div className="flex w-full max-w-sm items-center gap-3">
        <span className="font-display text-3xl font-bold tabular-nums text-text">{pct(m.p)}</span>
        <div className="h-2.5 flex-1 overflow-hidden bg-text/15">
          <div className="h-full bg-accent transition-[width] duration-500" style={{ width: pct(m.p) }} />
        </div>
      </div>
      <Status m={m} />
    </div>
  );
}

function Bar({ p }: { p: number }) {
  return (
    <div className="h-1 w-full max-w-sm overflow-hidden rounded-full bg-text/15">
      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: pct(p) }} />
    </div>
  );
}
