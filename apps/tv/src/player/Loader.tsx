// The first-load screen (selectable styles) shown while a stream is prepared
// and until its first frame. Everything animates with transforms and opacity
// only (cheap on old TV GPUs); poster_reveal uses static CSS filters
// (rasterised once) and cross-fades between layers.
//
// Each style except «Минимализм» is a chunk of its own (loaders/*): only the
// profile's style is fetched — ahead of time, with the player's code (see
// loaderChunks.ts); until it's there, Minimal stands in.
import { Suspense, useEffect, useRef, useState } from "react";
import type { MediaDetail, PlaybackSource } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { isLoaderPicker, Spinner, useAppliedDesign, useI18n, type LoaderPicker } from "@martytv/ui";
import { queryClient } from "../catalog/queries";
import { useFilmTheme } from "../filmtheme/load";
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

/** The title's Details if already cached (`seed` is the media id); never fetched here. */
function cachedDetail(id: string, locale: string): MediaDetail | null {
  return (queryClient.getQueryData(["media", id, catalogLang(locale)]) as MediaDetail | undefined) ?? null;
}

/** The loading screen in the chosen style. `preview` = settings thumbnail (no stats). */
export function Loader({ style, m, preview = false }: { style: LoadingStyle; m: LoaderModel; preview?: boolean }) {
  const { locale } = useI18n();
  // «Конструктивизм» and «Матрица»: their own loader whatever the style.
  const applied = useAppliedDesign();
  // «Сюрприз»: only Settings shows the setting itself (a load gets the picked style).
  if (isLoaderPicker(style)) return <PickTile picker={style} />;
  const kind = loaderKind(style, applied ?? "kinozal", preview);
  // «Тема под фильм»: the title's look (from its cached Details; not in Settings' preview).
  const filmTheme = useFilmTheme(preview ? null : cachedDetail(m.seed, locale));
  return (
    <div
      data-testid={preview ? "loader-preview" : m.done ? "loader-finale" : "player-preparing"}
      data-loader={style}
      data-film-theme={filmTheme ?? undefined}
      data-cv={kind === "poster" ? "1" : undefined}
      data-progress={Math.round(m.p * 100)}
      className={`tv-loader absolute left-0 top-0 h-full w-full overflow-hidden bg-bg${m.done && !preview ? " tv-loader-finale" : ""}`}
    >
      {kind === "minimal" ? (
        <Minimal m={m} />
      ) : (
        <Suspense fallback={<Minimal m={m} />}>
          <LazyStyle kind={kind} m={m} mood={style === "marty_popcorn" ? "popcorn" : "loading"} preview={preview} />
        </Suspense>
      )}
    </div>
  );
}

/** The chosen style's (lazy) component; Marty also takes the mood. */
function LazyStyle({ kind, m, mood, preview }: { kind: Exclude<LoaderKind, "minimal">; m: LoaderModel; mood: "loading" | "popcorn"; preview: boolean }) {
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
    case "paws":
      return <LOADERS.paws m={m} />;
    case "aquarium":
      return <LOADERS.aquarium m={m} />;
    case "speed88":
      return <LOADERS.speed88 m={m} />;
    case "odyssey":
      return <LOADERS.odyssey m={m} />;
    case "balloons":
      return <LOADERS.balloons m={m} />;
    case "catch":
      return <LOADERS.catch m={m} preview={preview} />;
    default: {
      // The rest take just the model.
      const Style = LOADERS[kind];
      return <Style m={m} />;
    }
  }
}

/** Settings' preview of a picker («Сюрприз»): a big «?» over shuffled cards. */
function PickTile({ picker }: { picker: LoaderPicker }) {
  const { t } = useI18n();
  return (
    <div data-testid="loader-preview" data-loader={picker} className="absolute left-0 top-0 h-full w-full overflow-hidden bg-bg">
      {[-14, 4, 18].map((r, i) => (
        <div
          key={r}
          className="absolute left-1/2 top-[170px] h-[520px] w-[360px] rounded-[40px] border-4 border-accent/40 bg-surface"
          style={{ transform: `translate3d(${-180 + (i - 1) * 200}px,0,0) rotate(${r}deg)`, opacity: 0.35 + i * 0.2 }}
        />
      ))}
      {picker === "surprise" ? (
        <p className="absolute left-0 right-0 top-[260px] text-center text-[300px] font-black leading-none text-accent">?</p>
      ) : (
        // «Под фильм»: a clapperboard.
        <svg className="absolute left-1/2 top-[250px] -translate-x-1/2 text-accent" width="320" height="300" viewBox="0 0 64 60" aria-hidden>
          <path d="M4 20 H60 V56 H4 Z" fill="currentColor" />
          <path d="M3 8 L58 2 L60 14 L5 20 Z" fill="currentColor" />
          <path d="M14 7 L22 18 M27 5.5 L35 16.5 M40 4 L48 15" stroke="rgb(var(--mt-bg))" strokeWidth="4" />
        </svg>
      )}
      <p className="absolute left-0 right-0 top-[760px] text-center text-7xl font-bold">{t(`settings.loading.${picker}`)}</p>
    </div>
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
