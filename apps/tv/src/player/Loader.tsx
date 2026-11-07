// The first-load screen (selectable styles) shown while a stream is prepared
// and until its first frame. Everything animates with transforms and opacity
// only (cheap on old TV GPUs); poster_reveal uses static CSS filters
// (rasterised once) and cross-fades between layers.
//
// Each style except «Минимализм» is a chunk of its own (loaders/*): only the
// profile's style is fetched — ahead of time, with the player's code (see
// loaderChunks.ts); until it's there, Minimal stands in.
import { Suspense, useEffect, useRef, useState } from "react";
import type { PlaybackSource } from "@martytv/contracts";
import { Spinner, useAppliedDesign } from "@martytv/ui";
import { loadTracker, SHOW_EVERY_MS, type LoadStage } from "./loading";
import type { LoadingStyle } from "../profile/settings";
import { Backdrop, pct, Status, type LoaderModel } from "./loaderParts";
import { LOADERS, loaderKind, type LoaderKind } from "./loaderChunks";

export type { LoaderModel };

/** The first load's progress: one tracker for the app, so a remount (or a page restart) doesn't restart it. */
const tracker = loadTracker;

type LoadInputs = { stage: LoadStage; source: Pick<PlaybackSource, "id" | "torrent" | "file" | "release"> | null; metadata: boolean; title?: string };

/**
 * Reads the app's one tracker (the only owner of the number) on a fixed
 * SHOW_EVERY_MS tick with the latest inputs — not once per poll / re-render
 * (the controller's poll and the screen's own torrent poll used to restart
 * it). Never goes backwards within one load attempt (`loadKey`).
 */
export function useLoadProgress(loadKey: string, stage: LoadStage, source: LoadInputs["source"], metadata: boolean, title?: string): number {
  const [p, setP] = useState(() => tracker.current(loadKey, title));
  const inputs = useRef<LoadInputs>({ stage, source, metadata, title });
  useEffect(() => {
    inputs.current = { stage, source, metadata, title };
  });
  useEffect(() => {
    const calc = () => {
      const i = inputs.current;
      setP(tracker.update(loadKey, { stage: i.stage, source: i.source, sourceId: i.source?.id ?? null, metadata: i.metadata, title: i.title }, Date.now()));
    };
    calc();
    if (stage === "done") return;
    const id = setInterval(calc, SHOW_EVERY_MS);
    return () => clearInterval(id);
  }, [loadKey, stage]);
  return p;
}

/** The loading screen in the chosen style. `preview` = settings thumbnail (no stats). */
export function Loader({ style, m, preview = false }: { style: LoadingStyle; m: LoaderModel; preview?: boolean }) {
  // «Конструктивизм» and «Матрица»: their own loader whatever the style.
  const applied = useAppliedDesign();
  const kind = loaderKind(style, applied ?? "kinozal", preview);
  return (
    <div
      data-testid={preview ? "loader-preview" : "player-preparing"}
      data-loader={style}
      data-cv={kind === "poster" ? "1" : undefined}
      data-progress={Math.round(m.p * 100)}
      className="tv-loader absolute left-0 top-0 h-full w-full overflow-hidden bg-bg"
    >
      {kind === "minimal" ? (
        <Minimal m={m} />
      ) : (
        <Suspense fallback={<Minimal m={m} />}>
          <LazyStyle kind={kind} m={m} mood={style === "marty_popcorn" ? "popcorn" : "loading"} />
        </Suspense>
      )}
    </div>
  );
}

/** The chosen style's (lazy) component; Marty also takes the mood. */
function LazyStyle({ kind, m, mood }: { kind: Exclude<LoaderKind, "minimal">; m: LoaderModel; mood: "loading" | "popcorn" }) {
  switch (kind) {
    case "popcorn":
      return <LOADERS.popcorn m={m} />;
    case "fill_title":
      return <LOADERS.fill_title m={m} />;
    case "poster_reveal":
      return <LOADERS.poster_reveal m={m} />;
    case "film_reel":
      return <LOADERS.film_reel m={m} />;
    case "marty":
      return <LOADERS.marty m={m} mood={mood} />;
    case "matrix":
      return <LOADERS.matrix m={m} />;
    case "poster":
      return <LOADERS.poster m={m} />;
  }
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

/** Small looping spinner for re-buffering during playback (no overlay). */
export function BufferingSpinner() {
  // «Матрица»: the green block spinner instead of the ring.
  const mx = useAppliedDesign() === "matrix";
  return (
    <div data-testid="player-buffering" className="tv-buffering absolute left-1/2 top-1/2 flex h-24 w-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full">
      {mx ? <Spinner size={48} /> : <span className="tv-spin block h-12 w-12 rounded-full" />}
    </div>
  );
}
