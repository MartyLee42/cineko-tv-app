// What the film-homage loading styles share (Glass, Dig, Chocolates, Coffee,
// Honey, Hyperjump, GhostMeter, Scanner, Docking, Claw): one layout (the
// scene on top, a caption, the title, a big percentage and the status), the
// stall detector, the cached Details of the title, the calm switch and a
// tiny Web Audio beep. Each style stays a chunk of its own; this bit is shared.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MediaDetail } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { uiSoundsPref, useI18n } from "@martytv/ui";
import { queryClient } from "../../catalog/queries";
import { useCalmMotion } from "../../design/skins";
import { StallTracker } from "../homage";
import { Backdrop, pct, Status, type LoaderModel } from "../loaderParts";
import "./homage.css";

export { useCalmMotion };

/** 100 % (or the first frame is up). */
export const isDone = (m: LoaderModel) => m.p >= 0.999 || m.stage === "done";

/**
 * The scene (`children`, drawn in a 1920-wide box `sceneH` tall from the
 * top), then the caption, the title, the percentage and the status.
 */
export function HomageLayout({
  m,
  name,
  caption,
  children,
  sceneH = 620,
  backdrop = 0.14,
  tone,
  full,
  className = "",
}: {
  m: LoaderModel;
  name: string;
  caption?: ReactNode;
  children: ReactNode;
  sceneH?: number;
  backdrop?: number;
  /** A fixed-colour stage under the scene (dark scenes on light designs). */
  tone?: string;
  /** A full-screen layer under everything (star fields, tints). */
  full?: ReactNode;
  className?: string;
}) {
  const calm = useCalmMotion();
  return (
    <div data-homage={name} data-calm={calm ? "1" : undefined} className={`hg-root absolute left-0 top-0 h-full w-full ${className}`}>
      <Backdrop m={m} opacity={backdrop} />
      <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      {full}
      <div className={`absolute left-0 top-0 w-full overflow-hidden ${tone ?? ""}`} style={{ height: sceneH }}>
        {children}
        {/* a fixed-colour stage melts into the screen at its foot */}
        {tone && <div className="hg-stage-foot absolute bottom-0 left-0 h-[70px] w-full" />}
      </div>
      <div className="absolute left-[160px] right-[160px] text-center" style={{ top: sceneH + 26 }}>
        {caption && (
          <p data-testid="homage-caption" className="hg-caption truncate text-[40px] italic leading-tight text-accent-strong">
            {caption}
          </p>
        )}
        <h1 className="mt-3 truncate text-6xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-1 truncate text-3xl text-muted">{m.episode}</p>}
        <div className="mt-6 flex items-start justify-center">
          <span className="mr-8 text-6xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
          <Status m={m} className="min-w-0 pt-1 text-left [&>p:first-child]:text-3xl" />
        </div>
      </div>
    </div>
  );
}

/** True while progress hasn't moved for ~6 s (re-checked every second). */
export function useStalled(p: number, ms = 6000): boolean {
  const tr = useRef<StallTracker | null>(null);
  const pRef = useRef(p);
  useEffect(() => {
    pRef.current = p;
  }, [p]);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = (tr.current ??= new StallTracker(ms));
    const tick = () => setStalled(t.update(pRef.current, Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [ms]);
  return stalled;
}

/** The title's Details if they're already in the cache (never fetched for the loader). `seed` is the media id. */
export function useCachedDetail(id: string): MediaDetail | null {
  const lang = catalogLang(useI18n().locale);
  return (queryClient.getQueryData(["media", id, lang]) as MediaDetail | undefined) ?? null;
}

/** Cached query data under `key` (no fetch). */
export function cached<T>(key: readonly unknown[]): T | null {
  return (queryClient.getQueryData(key) as T | undefined) ?? null;
}

type AC = typeof AudioContext;
let ctx: AudioContext | null = null;

/** A short sine beep — only when this device's «Звуки интерфейса» are on (off by default). */
export function beep(freq = 1320, dur = 0.12, gain = 0.08): void {
  if (!uiSoundsPref.get() || typeof window === "undefined") return;
  try {
    if (!ctx) {
      const w = window as unknown as { AudioContext?: AC; webkitAudioContext?: AC };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
    }
    const c = ctx;
    if (c.state === "suspended") void c.resume().catch(() => undefined);
    const t0 = c.currentTime + 0.01;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch {
    /* no Web Audio: silent */
  }
}
