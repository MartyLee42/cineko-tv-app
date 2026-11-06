import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { unwrap } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { useCatalogConfig } from "../catalog/queries";
import { Img, legacyColor } from "../components/Img";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";
import { refreshWatchData } from "./api";
import { starsToRating, type RateItem } from "./rating";
import { ratingQueue } from "./stores";

const subscribe = (cb: () => void) => ratingQueue.subscribe(cb);
const getPending = () => ratingQueue.pending;

/** Shows the queued "How was it?" prompt (when `enabled`: not during playback). */
export function RateLayer({ enabled }: { enabled: boolean }) {
  const item = useSyncExternalStore(subscribe, getPending);
  if (!enabled || !item) return null;
  return <RatePrompt key={`${item.media_id}:${item.episode_id ?? ""}`} item={item} />;
}

const STARS = 10;
/** Index STARS = "Not now". */
const SKIP = STARS;

/**
 * Quick reaction after credits: ten stars (the 1–10 rating) and "Not now".
 * ◀ ▶ choose, OK saves, Back skips.
 */
function RatePrompt({ item }: { item: RateItem }) {
  const { t } = useI18n();
  const cfg = useCatalogConfig();
  const [sel, setSel] = useState(7);
  const [thanks, setThanks] = useState(false);
  const selRef = useRef(sel);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  useEffect(() => {
    ratingQueue.shown(item);
    const c = claimKeys();
    let done = false;
    const finish = (stars: number | null) => {
      if (done) return;
      done = true;
      if (stars === null) return ratingQueue.skip(item);
      void unwrap(api.PUT("/profiles/{id}/ratings/{mediaId}", { params: { path: { id: item.profile_id, mediaId: item.media_id } }, body: { rating: starsToRating(stars) } }))
        .then(() => refreshWatchData(false))
        .catch(() => undefined);
      setThanks(true);
      setTimeout(() => ratingQueue.rated(item), 1200);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (done) return;
      if (k === "left") setSel((s) => Math.max(0, s - 1));
      else if (k === "right") setSel((s) => Math.min(SKIP, s + 1));
      else if (k === "ok") finish(selRef.current === SKIP ? null : selRef.current + 1);
      else if (k === "back") finish(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, [item]);

  return (
    <div data-testid="tv-rate" className="absolute left-0 top-0 z-30 h-full w-full bg-black/50">
      <div className="absolute bottom-20 left-1/2 flex w-[1320px] -translate-x-1/2 items-center rounded-[40px] bg-surface px-14 py-12 shadow-2xl">
        <div className="relative shrink-0 overflow-hidden rounded-2xl" style={{ width: 160, height: 240, background: legacyColor(placeholderColor(item.media_id)) }}>
          <Img src={imageUrl(cfg.data, item.poster_path, "w342")} className="absolute left-0 top-0 h-full w-full object-cover" />
        </div>
        <div className="ml-12 min-w-0 flex-1">
          {thanks ? (
            <p className="text-6xl font-bold text-accent">{t("rate.thanks")}</p>
          ) : (
            <>
              <h2 className="truncate text-5xl font-bold">{t("rate.title", { title: item.title })}</h2>
              <p className="mt-3 text-2xl text-muted">{t("rate.subtitle")}</p>
              <div className="mt-8 flex items-center">
                {Array.from({ length: STARS }, (_, i) => (
                  <span
                    key={i}
                    data-star={i + 1}
                    className={`tv-focus mr-1.5 flex h-[84px] w-[70px] items-center justify-center rounded-2xl text-[58px] leading-none ${
                      i === sel ? "is-focused bg-surface-2" : ""
                    } ${sel !== SKIP && i <= sel ? "text-accent" : "text-text/25"}`}
                  >
                    ★
                  </span>
                ))}
                <span
                  data-star="skip"
                  className={`tv-focus ml-6 rounded-2xl px-10 py-5 text-3xl font-semibold ${sel === SKIP ? "is-focused bg-text text-bg" : "bg-surface-2"}`}
                >
                  {t("rate.skip")}
                </span>
              </div>
              <p className="mt-6 text-2xl text-muted">
                {sel !== SKIP && <span className="mr-6 text-text">{t("tv.rate.stars", { n: sel + 1 })}</span>}
                {t("tv.rate.hint")}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
