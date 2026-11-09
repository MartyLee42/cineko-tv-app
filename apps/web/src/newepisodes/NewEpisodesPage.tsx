import { useEffect, useState } from "react";
import { Link } from "react-router";
import { airedKey, daysSinceAir, episodeCode, imageUrl, placeholderColor, pluralFormRu } from "@martytv/media-types";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Button } from "../components";
import { CatalogError, Img } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { BellIcon, CheckIcon, CloseIcon, PlayIcon } from "../icons";
import { NoProfile } from "../pages/HistoryPage";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useMarkNewSeen, useMutedSeries, useMuteSeries, useNewEpisodes } from "./queries";

/** «Вышла 3 дня назад». */
export function useAiredText() {
  const { t, locale } = useI18n();
  return (air: string | null | undefined): string => {
    const k = airedKey(daysSinceAir(air));
    if (!k) return "";
    if (k.key !== "newep.aired_days") return t(k.key as MessageKey);
    const form = locale === "ru" ? pluralFormRu(k.n) : k.n === 1 ? 0 : 2;
    return t(`newep.aired_days.${(["one", "few", "many"] as const)[form]}` as MessageKey, { n: k.n });
  };
}

/**
 * «Новые серии»: episodes of the profile's series that aired after what it
 * watched (checked every night on the server). Watch opens the title on that
 * episode; Hide marks it seen; «Не уведомлять о сериале» mutes the series
 * (undo toast; muted series are listed at the bottom to unmute).
 */
export function NewEpisodesPage() {
  const { t } = useI18n();
  const { profile } = useActiveProfile();
  const q = useNewEpisodes();
  const mark = useMarkNewSeen();
  const cfg = useCatalogConfig();
  const aired = useAiredText();
  const mute = useMuteSeries();
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const id = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(id);
  }, [undo]);
  if (!profile) return <NoProfile />;
  const items = q.data?.items ?? [];
  const unseen = q.data?.unseen ?? 0;
  return (
    <div data-testid="new-episodes-page" className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("newep.title")}</h1>
        {unseen > 0 && <span className="rounded-full bg-accent px-2.5 py-0.5 text-sm font-bold text-on-accent">{t("newep.count", { n: unseen })}</span>}
        {unseen > 0 && (
          <Button variant="secondary" className="ml-auto" busy={mark.isPending} onClick={() => mark.mutate({ all: true })}>
            <CheckIcon /> {t("newep.mark_all")}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <CatalogError error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface px-6 py-10 text-center text-muted">{t("newep.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => {
            const e = it.episode;
            const still = e.still_path ?? it.media.backdrop_path ?? null;
            const href = `/title/${it.media.id}?season=${e.season_number}&episode=${e.episode_number}`;
            return (
              <li key={e.id} data-new-episode={e.id} data-seen={it.seen ? "1" : "0"} className={`flex gap-4 rounded-2xl bg-surface p-3 ${it.seen ? "opacity-60" : ""}`}>
                <Link to={href} className="relative block aspect-video w-32 shrink-0 overflow-hidden rounded-xl sm:w-48" style={{ background: placeholderColor(it.media.id) }}>
                  <Img src={imageUrl(cfg.data, still, "w300")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-muted">
                    {!it.seen && <span className="rounded-full bg-accent px-2 font-bold text-on-accent">{t("newep.badge_new")}</span>}
                    <span className="truncate">{aired(e.air_date)}</span>
                    {it.source === "kinopoisk" && <span className="shrink-0 rounded-full border border-border px-1.5">{t("newep.from_kinopoisk")}</span>}
                  </div>
                  <Link to={href} className="mt-0.5 block truncate font-semibold hover:underline">
                    {it.media.title}
                  </Link>
                  <p className="truncate text-sm text-muted">
                    <span className="font-semibold text-accent">{episodeCode(e.season_number, e.episode_number)}</span>
                    {e.name ? ` · ${e.name}` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link to={href} className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-accent px-3 text-sm font-semibold text-on-accent">
                      <PlayIcon /> {t("newep.watch")}
                    </Link>
                    {!it.seen && (
                      <Button variant="ghost" className="min-h-[36px] text-sm" onClick={() => mark.mutate({ episode_ids: [e.id] })}>
                        {t("newep.hide")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="min-h-[36px] text-sm"
                      data-testid="new-episode-mute"
                      onClick={() => {
                        mute.mutate({ mediaId: it.media.id, on: true });
                        setUndo({ id: it.media.id, title: it.media.title });
                      }}
                    >
                      <BellIcon off /> {t("newepmute.mute")}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <MutedSeriesSection />
      {undo && (
        <div
          role="status"
          data-testid="new-episode-mute-undo"
          className="fixed inset-x-4 bottom-[calc(76px+env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm shadow-2xl shadow-black/40 md:bottom-6"
        >
          <span className="min-w-0 flex-1">{t("newepmute.muted", { title: undo.title })}</span>
          <button
            type="button"
            className="shrink-0 rounded-lg px-2 py-1 font-semibold underline hover:bg-surface-2"
            onClick={() => {
              mute.mutate({ mediaId: undo.id, on: false });
              setUndo(null);
            }}
          >
            {t("newepmute.undo")}
          </button>
          <button type="button" aria-label={t("common.close")} className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2" onClick={() => setUndo(null)}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}

/** «Скрытые сериалы (N)»: muted series, folded; each can be unmuted. */
function MutedSeriesSection() {
  const { t } = useI18n();
  const q = useMutedSeries();
  const mute = useMuteSeries();
  const cfg = useCatalogConfig();
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <details data-testid="muted-series" className="rounded-2xl bg-surface p-3">
      <summary className="cursor-pointer select-none px-1 font-semibold text-muted">{t("newepmute.hidden", { n: items.length })}</summary>
      <ul className="mt-3 space-y-2">
        {items.map(({ media: m }) => (
          <li key={m.id} data-muted-series={m.id} className="flex items-center gap-3">
            <Link to={`/title/${m.id}`} className="relative block h-16 w-11 shrink-0 overflow-hidden rounded-lg" style={{ background: placeholderColor(m.id) }}>
              <Img src={imageUrl(cfg.data, m.poster_path ?? null, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
            </Link>
            <Link to={`/title/${m.id}`} className="min-w-0 flex-1 truncate font-semibold hover:underline">
              {m.title}
            </Link>
            <Button variant="secondary" className="min-h-[36px] shrink-0 text-sm" onClick={() => mute.mutate({ mediaId: m.id, on: false })}>
              <BellIcon /> {t("newepmute.unmute")}
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Link to the page with the unseen count (Home; the phone bar has no room for another tab). */
export function NewEpisodesLink() {
  const { t } = useI18n();
  const q = useNewEpisodes();
  const unseen = q.data?.unseen ?? 0;
  if (unseen === 0) return null;
  return (
    <Link to="/new-episodes" data-testid="new-episodes-link" className="flex items-center justify-between rounded-2xl bg-surface px-4 py-3 font-semibold hover:bg-surface-2">
      <span>{t("newep.title")}</span>
      <span className="rounded-full bg-accent px-2.5 py-0.5 text-sm font-bold text-on-accent">{t("newep.count", { n: unseen })}</span>
    </Link>
  );
}
