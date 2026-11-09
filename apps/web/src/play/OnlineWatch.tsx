// «Смотреть онлайн»: a title-page button (next to the main play buttons)
// that plays an online source (CDNVideoHub, Collaps…) without a torrent.
// It appears only when GET /media/{id}/online — fetched lazily after the page
// opens — has non-anime variants. It opens a compact picker grouped by
// source: voice-over chips (preferred first), quality, season/episode for
// series; «Смотреть здесь» / «На телевизоре» use the existing play flows.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { MediaDetail } from "@martytv/contracts";
import { episodeCode } from "@martytv/media-types";
import { CvIcon, Spinner, useConstructivism, useI18n } from "@martytv/ui";
import { useSeason } from "../catalog/queries";
import { defaultSeason, orderSeasons } from "../catalog/seasons";
import { CastIcon, DeviceIcon, StarIcon } from "../icons";
import { watchUrl } from "../player/logic";
import { writeWatchWhere } from "../player/session";
import { Sheet } from "../remote/SendToTv";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useMediaProgress } from "../watch/queries";
import { assessOnlineHere } from "./browserSupport";
import { BrowserBadge } from "./ReleaseList";
import { usePlayOnTv, type PlayTarget } from "./PlayOnTv";
import { createSource, sourceKey } from "./queries";
import { createLatest } from "./abandon";
import { defaultEpisode, defaultVariant, groupBySource, onlineOnly, sortedQualities, variantEpisodes } from "./onlineWatch";
import { useOnline, type OnlineVariant } from "./sourcesApi";

/** The season the page shows (?season=), else the next-up one, else the default. */
function useShownSeason(m: MediaDetail): number | undefined {
  const [params] = useSearchParams();
  const next = useMediaProgress(m.id).data?.next_up ?? null;
  if (m.kind !== "series") return undefined;
  const fromUrl = Number(params.get("season"));
  if (params.get("season") != null && m.seasons.some((s) => s.season_number === fromUrl)) return fromUrl;
  if (next && m.seasons.some((s) => s.season_number === next.season_number)) return next.season_number;
  return defaultSeason(m.seasons) ?? 1;
}

/** Whether the title has online variants (for the shown season) — the button / menu entry shows only then. */
export function useHasOnline(m: MediaDetail): { has: boolean; season: number | undefined } {
  const { profileId } = useActiveProfile();
  const season = useShownSeason(m);
  const q = useOnline({ media_id: m.id, ...(season != null && { season_number: season }) }, profileId ?? undefined);
  return { has: onlineOnly(q.data).length > 0, season };
}

export function OnlineWatchButton({ m, className = "" }: { m: MediaDetail; className?: string }) {
  const { t } = useI18n();
  const { has, season } = useHasOnline(m);
  const [open, setOpen] = useState(false);
  if (!has && !open) return null;
  return (
    <>
      {has && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="watch-online"
          title={t("online.watch_hint")}
          className={`inline-flex min-h-[48px] items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-accent/60 bg-surface/70 px-4 font-semibold text-text backdrop-blur transition hover:border-accent hover:bg-accent/10 sm:px-5 ${className}`}
        >
          <StreamIcon className="text-xl text-accent" />
          {t("online.watch")}
        </button>
      )}
      {open && <OnlinePicker m={m} initialSeason={season} onClose={() => setOpen(false)} />}
    </>
  );
}

export function OnlinePicker({ m, initialSeason, onClose }: { m: MediaDetail; initialSeason: number | undefined; onClose: () => void }) {
  const { t } = useI18n();
  const { profileId } = useActiveProfile();
  const next = useMediaProgress(m.id).data?.next_up ?? null;
  const series = m.kind === "series";
  const [season, setSeason] = useState(initialSeason);
  const q = useOnline({ media_id: m.id, ...(season != null && { season_number: season }) }, profileId ?? undefined);
  const items = useMemo(() => onlineOnly(q.data), [q.data]);
  const groups = useMemo(() => groupBySource(items), [items]);
  const eps = useSeason(m.id, series ? (season ?? null) : null);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const variant = items.find((v) => v.id === pickedId) ?? defaultVariant(items);
  const wanted = next && next.season_number === season ? next.episode_number : null;
  const [pickedEp, setPickedEp] = useState<number | null>(null);
  const episode = series && variant ? (pickedEp != null && variantEpisodes(variant).includes(pickedEp) ? pickedEp : defaultEpisode(variant, wanted)) : null;
  const [quality, setQuality] = useState<number | null>(null); // null = auto (server: best ≤ profile's resolution)
  const qualities = variant ? sortedQualities(variant.qualities) : [];
  const q2 = quality != null && qualities.includes(quality) ? quality : null;

  const epInfo = episode != null ? eps.data?.episodes.find((e) => e.episode_number === episode) : undefined;
  const code = season != null && episode != null ? episodeCode(season, episode) : "";
  const target: PlayTarget | null = !variant
    ? null
    : series
      ? epInfo && season != null && episode != null
        ? { media_id: m.id, season_number: season, episode_number: episode, episode_id: epInfo.id, label: `${m.title} · ${code}`, detail: epInfo.name ?? undefined }
        : null
      : { media_id: m.id, label: m.title };

  const qc = useQueryClient();
  const navigate = useNavigate();
  const { play } = usePlayOnTv();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Closing the picker (or leaving the page) while the source is created: don't open the player afterwards.
  const [runs] = useState(createLatest);
  useEffect(() => () => runs.cancel(), [runs]);
  const watchHere = async () => {
    if (!variant || !target) return;
    const run = runs.begin();
    setBusy(true);
    setFailed(false);
    try {
      const src = await createSource({
        media_id: m.id,
        release_id: variant.id,
        ...(target.episode_id && { episode_id: target.episode_id }),
        ...(profileId && { profile_id: profileId }),
        ...(q2 != null && { quality: q2 }),
      });
      if (!run.live()) return;
      qc.setQueryData(sourceKey(src.id), src);
      writeWatchWhere("here");
      navigate(watchUrl(target, { sourceId: src.id }));
    } catch {
      if (!run.live()) return;
      setFailed(true);
      setBusy(false);
    }
  };
  const onTv = () => {
    if (!variant || !target) return;
    onClose();
    play({ ...target, release_id: variant.id, ...(q2 != null && { quality: q2 }) });
  };

  const seasons = series ? orderSeasons(m.seasons) : [];
  const support = variant ? assessOnlineHere(variant.format) : null;

  return (
    <Sheet title={t("online.picker.title")} subtitle={m.title} onClose={onClose} testId="online-picker">
      <div className="space-y-4">
        {series && seasons.length > 1 && (
          <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1" role="tablist" aria-label={t("catalog.detail.seasons")}>
            {seasons.map((s) => (
              <Chip
                key={s.season_number}
                on={s.season_number === season}
                onClick={() => {
                  setSeason(s.season_number);
                  setPickedId(null);
                  setPickedEp(null);
                }}
                testId="online-season"
              >
                {s.season_number === 0 ? t("catalog.detail.specials") : t("online.picker.season", { n: s.season_number })}
              </Chip>
            ))}
          </div>
        )}

        {q.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted" data-testid="online-picker-loading">
            <Spinner size={14} />
            {t("online.picker.loading")}
          </p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted" data-testid="online-picker-empty">
            {t("online.picker.empty")}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.provider.id} className="space-y-2" data-testid="online-source" data-source-id={g.provider.id}>
              <h3 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider">
                <span className="text-accent">{g.provider.name}</span>
                <span className="text-muted">· {t("online.picker.voices", { n: g.variants.length })}</span>
              </h3>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`${t("online.picker.voice")} · ${g.provider.name}`}>
                {g.variants.map((v) => (
                  <VoiceChip
                    key={v.id}
                    v={v}
                    on={v.id === variant?.id}
                    onClick={() => {
                      setPickedId(v.id);
                      setFailed(false);
                    }}
                  />
                ))}
              </div>
            </section>
          ))
        )}

        {variant && (
          <div className="space-y-3 border-t border-border pt-3" data-testid="online-selected">
            {qualities.length > 1 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("online.picker.quality")}</p>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("online.picker.quality")}>
                  <Chip on={q2 == null} onClick={() => setQuality(null)} testId="online-quality" role="radio">
                    {t("online.picker.quality_auto")}
                  </Chip>
                  {qualities.map((x) => (
                    <Chip key={x} on={q2 === x} onClick={() => setQuality(x)} testId="online-quality" role="radio">
                      {x}p
                    </Chip>
                  ))}
                </div>
              </div>
            )}
            {series && (
              <label className="block space-y-1.5">
                <span className="block text-xs font-semibold uppercase tracking-wider text-muted">{t("online.picker.episodes")}</span>
                <select
                  value={episode ?? ""}
                  onChange={(e) => setPickedEp(Number(e.target.value))}
                  data-testid="online-episode"
                  className="min-h-[44px] w-full rounded-xl border border-border bg-surface-2 px-3 text-sm"
                >
                  {variantEpisodes(variant).map((n) => {
                    const ep = eps.data?.episodes.find((e) => e.episode_number === n);
                    return (
                      <option key={n} value={n}>
                        {t("online.picker.episode", { n })}
                        {ep?.name ? ` · ${ep.name}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="rounded border border-border px-1 text-[10px] font-bold uppercase tracking-wide">{variant.format}</span>
              {variant.subtitle_langs.length > 0 && (
                <span>
                  {t("online.picker.subtitles")}: {variant.subtitle_langs.join(", ")}
                </span>
              )}
              {support && <BrowserBadge support={support} />}
            </div>
            {failed && (
              <p className="text-sm text-danger" role="alert" data-testid="online-failed-start">
                {t("online.picker.failed")}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void watchHere()}
                disabled={!target || busy}
                data-testid="online-play-here"
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-accent px-4 font-bold text-on-accent transition hover:bg-accent-strong disabled:opacity-60"
              >
                {busy ? <Spinner size={18} /> : <DeviceIcon className="text-lg" />}
                {t("online.picker.play_here")}
              </button>
              <button
                type="button"
                onClick={onTv}
                disabled={!target || busy}
                data-testid="online-play-tv"
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 px-4 font-semibold transition hover:border-accent disabled:opacity-60"
              >
                <CastIcon className="text-lg" />
                {t("online.picker.play_tv")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function VoiceChip({ v, on, onClick }: { v: OnlineVariant; on: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      data-testid="online-voice-chip"
      data-variant-id={v.id}
      data-preferred={v.preferred ? "true" : undefined}
      title={v.preferred ? t("online.picker.preferred") : undefined}
      className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-3 text-sm font-semibold transition ${
        on ? "border-accent bg-accent text-on-accent" : "border-border bg-surface-2 hover:border-accent"
      }`}
    >
      {v.preferred && <StarIcon className="text-xs" />}
      {v.voice}
      {v.max_quality ? <span className={`text-[11px] font-bold ${on ? "text-on-accent/80" : "text-muted"}`}>{v.max_quality}p</span> : null}
    </button>
  );
}

function Chip({
  on,
  onClick,
  children,
  testId,
  role = "tab",
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  role?: "tab" | "radio";
}) {
  return (
    <button
      type="button"
      role={role}
      aria-selected={role === "tab" ? on : undefined}
      aria-checked={role === "radio" ? on : undefined}
      onClick={onClick}
      data-testid={testId}
      className={`min-h-[40px] shrink-0 whitespace-nowrap rounded-full border px-3 text-sm font-semibold transition ${
        on ? "border-accent bg-accent/15 text-accent-strong" : "border-border bg-surface-2 hover:border-accent"
      }`}
    >
      {children}
    </button>
  );
}

/** Play triangle inside a signal arc: "streams at once". */
export function StreamIcon({ className = "" }: { className?: string }) {
  if (useConstructivism()) return <CvIcon glyph="play" className={className} />;
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
      <path d="M10 8.5v7l5.5-3.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}
