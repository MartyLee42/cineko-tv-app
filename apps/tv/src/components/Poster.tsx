import type { CatalogConfig, MediaSummary } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { Img, legacyColor } from "./Img";
import { barFraction } from "../watch/resume";

/** Poster card visuals (focus is handled by the row/grid slot around it). */
export function Poster({
  item,
  cfg,
  width,
  height,
  focused,
  showTitle,
}: {
  item: MediaSummary;
  cfg: CatalogConfig | undefined;
  width: number;
  height: number;
  focused: boolean;
  showTitle?: boolean;
}) {
  return (
    <div style={{ width }} data-card-id={item.id} className={focused ? "mt-hop" : undefined}>
      <div
        className={`tv-focus relative overflow-hidden rounded-2xl ${focused ? "is-focused" : ""}`}
        style={{ width, height, background: legacyColor(placeholderColor(item.id)) }}
      >
        {/* Placeholder: visible until the poster loads, and if it never does. */}
        <div className="absolute bottom-0 left-0 right-0 p-5">
          <p className="line-clamp-4 text-2xl font-semibold leading-tight text-text">{item.title}</p>
          {item.year && <p className="mt-2 text-xl text-muted">{item.year}</p>}
        </div>
        <Img src={imageUrl(cfg, item.poster_path, "w342")} className="absolute left-0 top-0 h-full w-full object-cover" />
        <WatchBadges me={item.me} />
      </div>
      {showTitle && (
        <p className={`mt-4 truncate text-2xl ${focused ? "font-semibold text-text" : "text-muted"}`}>{item.title}</p>
      )}
    </div>
  );
}

/**
 * Like the web posters: a watched ✓ and a favourite ♥ in the top-left corner
 * (the rating badge owns the top-right), plus a thin progress bar along the
 * bottom while unfinished. `top` moves the marks down (Терминал's index tag).
 */
export function WatchBadges({ me, top = 12, progress = true }: { me?: MediaSummary["me"]; top?: number; progress?: boolean }) {
  if (!me) return null;
  const f = !me.completed && progress ? barFraction(me.progress_percent) : null;
  return (
    <>
      {(me.completed || me.favorite) && (
        <span className="absolute left-3 flex flex-col" style={{ top }}>
          {me.completed && (
            <span data-watched className="tv-check flex h-11 w-11 items-center justify-center rounded-full text-2xl font-bold shadow-lg">
              ✓
            </span>
          )}
          {me.favorite && (
            <span data-favorite className={`flex h-11 w-11 items-center justify-center rounded-full bg-black/65 text-[24px] leading-none text-rose-400 shadow-lg ${me.completed ? "mt-2" : ""}`}>
              ♥
            </span>
          )}
        </span>
      )}
      {f !== null && <ProgressBar fraction={f} />}
    </>
  );
}

export function ProgressBar({ fraction, className = "" }: { fraction: number; className?: string }) {
  return (
    <span data-progress={Math.round(fraction * 100)} className={`tv-progress absolute bottom-0 left-0 right-0 h-2 ${className}`}>
      <span className="tv-progress-fill absolute left-0 top-0 h-full w-full" style={{ transform: `scaleX(${fraction})` }} />
    </span>
  );
}
