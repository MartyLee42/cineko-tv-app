// What every loading style shares: the model, the status lines, the dimmed
// backdrop and the poster card. Each style is a chunk of its own (loaders/*,
// see loaderChunks.ts); Loader.tsx picks one.
import type { ReactNode } from "react";
import type { PlaybackSource } from "@martytv/contracts";
import { placeholderColor } from "@martytv/media-types";
import { loadStatus, useI18n } from "@martytv/ui";
import { Img, legacyColor } from "../components/Img";
import { formatBytes, formatSpeed } from "./format";
import { preloadTarget, type LoadStage } from "./loading";

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
  /** The first frame is there: the style's end flourish (shown briefly over the starting film). */
  done?: boolean;
}

/**
 * The drawn styles' layout (paws, aquarium, speed88, odyssey, balloons):
 * the art (1200 × 560) centred at the top, the title, the big percentage
 * and the status under it.
 */
export function ArtLayout({ m, children }: { m: LoaderModel; children: ReactNode }) {
  return (
    <>
      <Backdrop m={m} opacity={0.14} />
      <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      <div className="absolute left-[360px] top-[80px]">{children}</div>
      <div className="absolute left-[160px] right-[160px] top-[690px] text-center">
        <h1 className="truncate text-6xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-2 truncate text-3xl text-muted">{m.episode}</p>}
        <div className="mt-8 flex items-start justify-center">
          <span data-testid="loader-pct" className="mr-8 text-6xl font-bold tabular-nums text-accent">
            {pct(m.done ? 1 : m.p)}
          </span>
          <Status m={m} className="min-w-0 pt-1 text-left" />
        </div>
      </div>
    </>
  );
}

export function useStatus(m: LoaderModel): { status: string; stats: string[] } {
  const { t, locale } = useI18n();
  const fmt = { bytes: (n: number) => formatBytes(n, locale), speed: (b: number) => formatSpeed(b, locale) };
  const { status, stats } = loadStatus(
    { stage: m.stage, torrent: m.torrent, target: preloadTarget(m.fileBytes ?? null), compat: m.compat ?? null, online: !!m.online },
    fmt,
  );
  return { status: t(status.key, status.vars), stats: stats.map((l) => t(l.key, l.vars)) };
}

/** Whole percent, rounded down: «100 %» only once it is really there. */
export const pct = (p: number) => `${p >= 1 ? 100 : Math.max(0, Math.floor(p * 100))}%`;

export function Status({ m, className = "" }: { m: LoaderModel; className?: string }) {
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

export function Backdrop({ m, opacity }: { m: LoaderModel; opacity: number }) {
  return (
    <div className="absolute left-0 top-0 h-full w-full" style={{ opacity }}>
      <Img src={m.backdrop ?? m.poster} className="absolute left-0 top-0 h-full w-full object-cover" />
    </div>
  );
}

export function PosterCard({ m, w, h, className = "", children }: { m: LoaderModel; w: number; h: number; className?: string; children?: ReactNode }) {
  return (
    <div className={`relative overflow-hidden rounded-3xl shadow-2xl ${className}`} style={{ width: w, height: h, background: legacyColor(placeholderColor(m.seed)) }}>
      <p className="absolute bottom-0 left-0 right-0 p-6 text-3xl font-semibold text-white">{m.title}</p>
      {children ?? <Img src={m.poster} className="absolute left-0 top-0 h-full w-full object-cover" />}
    </div>
  );
}
