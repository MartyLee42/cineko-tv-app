import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { ApiError, type Release } from "@martytv/contracts";
import { episodeRanges, groupProviders, imageUrl, qualitiesLabel, variantHasEpisode, variantRelease } from "@martytv/media-types";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { FocusButton, FocusLine, FocusSection, setFocus } from "../focus";
import { useCatalogConfig } from "../catalog/queries";
import { Backdrop } from "../components/Img";
import { constraintsText, networkHint, networkHintText } from "@martytv/media-types";
import { fitCoveredWarnings, fitInput, judgeFit, type Fit } from "@martytv/media-types";
import { engineProbe, heavyMbps, rankForTv } from "./codecs";
import { thisTvCaps } from "./fitCaps";
import { FitLine } from "./FitLine";
import { WARNING_KEYS } from "./format";
import { mbit, rateStore } from "./rebuffer";
import { refreshReleases, releaseQuery, useOnline, useRefinedReleases, useReleases, type OnlineVariant, type Refine } from "./data";
import { pickerOnlineGroup } from "./online";
import { RefineScreen } from "./RefineScreen";
import { isUncertain } from "./refine";
import { episodeLabel, releaseRow } from "./format";
import { player } from "./controller";
import type { PlayContext } from "./session";
import { playerKey } from "./keys";
import { findDownload, useDownloadLabel, useMediaDownloads } from "./downloads";
import { HEAD_H, LIST_H, LIST_TOP, pickerScroll, ROW_GAP, ROW_H, type Sel } from "./pickerLayout";

const LONG_PRESS_MS = 700;

/** Fullscreen release list: best match first and focused, OK plays. */
export function ReleasePicker({ ctx, tried }: { ctx: PlayContext; tried: readonly string[] }) {
  const { t, locale } = useI18n();
  const cfg = useCatalogConfig();
  // «Показать все»: rank without this TV's playback profile.
  const [showAll, setShowAll] = useState(false);
  const q = useMemo(() => ({ ...releaseQuery(ctx), ...(showAll ? { all: true } : {}) }), [ctx, showAll]);
  const base = useReleases(q);
  // «Уточнить поиск»: the user's own query replaces the automatic results.
  const [refine, setRefine] = useState<Refine | null>(null);
  const [editing, setEditing] = useState(false);
  const refined = useRefinedReleases(q, refine);
  const list = refine ? refined : base;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [sel, setSel] = useState<Sel>({ kind: "rel", i: 0 });
  // The server ranks for this TV's playback profile (decodable codecs, its
  // throughput, manual limits). On top of that the TV re-orders by bitrate
  // only: in «Выбрать раздачу полегче» (the rate just measured), or when the
  // server had no profile to apply (its last measured rate). Audio is judged
  // by the server profile and the row warnings, not re-ordered here.
  const env = useMemo(() => player.rankEnv(ctx), [ctx]);
  const fit = list.data?.device ?? null;
  const items = useMemo(() => {
    const raw = list.data?.items ?? [];
    if (showAll || (fit && !player.lighterRate)) return raw;
    return rankForTv(raw, { ...env, probe: undefined });
  }, [list.data, env, fit, showAll]);
  const fitText = constraintsText(fit?.constraints, (k, v) => t(k as MessageKey, v)) || null;
  // «Сеть сейчас ~8 Мбит/с — без рывков пойдут 1080p до ~4 ГБ»: a recent
  // measurement (speed test / playback) too slow for some of these releases.
  const net = networkHint(items, rateStore.hintBps());
  const netText = net ? networkHintText(net, (k, v) => t(k as MessageKey, v)) : null;
  // «Онлайн · CDNVideoHub, Collaps» / «Аниме · AniLiberty»: online variants, fast and independent of the torrent search.
  const onlineQ = useOnline(q);
  const group = useMemo(() => pickerOnlineGroup(onlineQ.data), [onlineQ.data]);
  const online = group.items;
  const remembered = player.remembered(ctx);
  // «✓ Пойдёт» / «Звук DTS → сервер переведёт в AAC» / «✗ Видео HEVC не поддерживается».
  const caps = useMemo(() => thisTvCaps(engineProbe()), []);
  const downloads = useMediaDownloads(ctx.media_id);
  const dlLabel = useDownloadLabel();

  const refresh = async () => {
    if (refine) return void refined.refetch();
    setRefreshing(true);
    setRefreshError(null);
    try {
      await refreshReleases(q);
    } catch (e) {
      setRefreshError(e);
    } finally {
      setRefreshing(false);
    }
  };

  // Focus the remembered release (torrent or online), else the preferred
  // online variant, else the best untried torrent; or the action button.
  const ready = !list.isPending && !refreshing && !editing;
  const listKey = items.map((r) => r.id).join(",");
  const onlineKey = online.map((v) => v.id).join(",");
  const playableOnline = online.findIndex((v) => variantHasEpisode(v, ctx.episode) && !tried.includes(v.id));
  useEffect(() => {
    if (editing || refreshing) return;
    const lastOnline = online.findIndex((v) => v.id === remembered && !tried.includes(v.id));
    if (lastOnline >= 0) return void setFocus(`onl-${lastOnline}`);
    // Torrents still searching: the online variants are already playable.
    if (!ready) {
      if (playableOnline >= 0) void setFocus(`onl-${playableOnline}`);
      return;
    }
    const last = items.findIndex((r) => r.id === remembered && !tried.includes(r.id));
    if (last >= 0) return void setFocus(`rel-${last}`);
    if (playableOnline >= 0) return void setFocus(`onl-${playableOnline}`);
    if (items.length === 0) return void setFocus("picker-refine");
    const at = Math.max(0, items.findIndex((r) => !tried.includes(r.id)));
    // (The row's onFocus updates the selection.)
    void setFocus(`rel-${at}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, listKey, onlineKey, refine]);

  const playVariant = (v: OnlineVariant) => {
    if (!variantHasEpisode(v, ctx.episode)) return;
    player.playRelease(ctx, variantRelease(v));
  };

  // The Play media key on a row plays it too (same as OK).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = playerKey(e);
      if (k !== "play" && k !== "playpause") return;
      if (sel.kind === "onl" && online[sel.i]) {
        e.preventDefault();
        if (variantHasEpisode(online[sel.i]!, ctx.episode)) player.playRelease(ctx, variantRelease(online[sel.i]!));
      } else if (sel.kind === "rel" && items[sel.i]) {
        e.preventDefault();
        player.playRelease(ctx, items[sel.i]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, online, sel, ctx]);

  const err = refreshError ?? list.error;
  const ep = episodeLabel(ctx.season, ctx.episode, ctx.episode_name);
  const keys = ["picker-actions", ...online.map((_, i) => `onl-${i}`), ...items.map((_, i) => `rel-${i}`)];
  const failedLine = group.failed.length > 0;
  const scroll = pickerScroll(sel, online.length, items.length, failedLine);
  const errors = list.data?.indexer_errors ?? [];
  const groupNames = groupProviders(online, group.failed).join(", ");

  return (
    <div data-testid="release-picker" className="relative h-full w-full overflow-hidden bg-bg">
      <div className="absolute right-0 top-0 h-[700px] w-[1300px] opacity-40">
        <Backdrop src={imageUrl(cfg.data, ctx.backdrop_path, "w1280")} />
        <div className="tv-scrim-left absolute left-0 top-0 h-full w-full" />
        <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      </div>

      <FocusLine focusKey="picker" keys={keys} className="absolute left-0 top-0 h-full w-full">
      <div className="absolute left-24 right-24 top-20 flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-3xl text-accent">{t("player.choose_release")}</p>
          <h1 className="mt-3 truncate text-6xl font-bold">{ctx.title}</h1>
          <p className="mt-4 h-10 truncate text-3xl text-muted">
            {refine ? `${t("tv.refine.query", { q: refine.text })} · ` : ""}
            {ep}
            {ep && items.length > 0 ? " · " : ""}
            {items.length > 0 ? t("player.tv.releases_n", { n: items.length }) : ""}
          </p>
          {(fitText || player.lighterRate || netText) && (
            <p data-testid="picker-fit" data-net={net ? net.mbps : undefined} className="mt-2 h-9 max-w-[1100px] truncate text-2xl text-accent">
              {player.lighterRate
                ? t("tvplay.picker.lighter", { rate: mbit(player.lighterRate) })
                : (netText ?? t("tvplay.picked_for", { list: fitText ?? "" }))}
            </p>
          )}
        </div>
        <FocusSection focusKey="picker-actions" preferredChildFocusKey={items.length === 0 ? "picker-refine" : undefined} className="flex shrink-0">
          <FocusButton
            focusKey="picker-refine"
            onPress={() => setEditing(true)}
            className={`flex items-center rounded-control px-9 py-5 text-3xl font-semibold ${items.length === 0 && ready ? "bg-accent text-on-accent" : "bg-surface-2"}`}
          >
            <span className="text-3xl">⌕</span>
            <span className="ml-4">{items.length === 0 && ready ? t("tv.refine.button") : t("tv.refine.short")}</span>
          </FocusButton>
          {(fit || showAll) && (
            <FocusButton
              focusKey="picker-all"
              onPress={() => setShowAll((v) => !v)}
              className="mr-5 flex items-center rounded-control bg-surface-2 px-9 py-5 text-3xl font-semibold"
            >
              <span data-testid="picker-show-all">{showAll ? t("tvplay.show_fit") : t("tvplay.show_all")}</span>
            </FocusButton>
          )}
          <FocusButton
            focusKey="picker-refresh"
            onPress={() => void refresh()}
            className="ml-5 flex items-center rounded-control bg-surface-2 px-9 py-5 text-3xl font-semibold"
          >
            {refreshing || (refine && refined.isFetching) ? <Spinner size={30} /> : <span className="text-3xl">⟳</span>}
            <span className="ml-4">{t("player.retry_search")}</span>
          </FocusButton>
        </FocusSection>
      </div>
          <div className="absolute overflow-hidden" style={{ left: 96, top: LIST_TOP, width: 1728, height: LIST_H }}>
            <div className="tv-track" style={{ transform: `translate3d(0,${-scroll}px,0)` }}>
              {group.show && (
                <div data-testid="picker-online">
                  <p className="flex items-center text-3xl font-semibold" style={{ height: HEAD_H }}>
                    <span className="text-accent">{group.kinds.map((k) => t(`sources.kind.${k}`)).join(" · ")}</span>
                    <span className="ml-4 text-muted">· {groupNames}</span>
                  </p>
                  {failedLine && (
                    <p className="truncate text-2xl text-muted" style={{ height: 48 }} data-testid="picker-online-failed">
                      ⚠ {t("sources.group.failed", { list: group.failed.map((p) => p.name).join(", ") })}
                    </p>
                  )}
                  {online.map((v, i) => (
                    <VariantRowView
                      key={v.id}
                      index={i}
                      variant={v}
                      episode={ctx.episode}
                      last={v.id === remembered}
                      failed={tried.includes(v.id)}
                      onFocus={() => setSel({ kind: "onl", i })}
                      onPress={() => playVariant(v)}
                      onLongPress={() => variantHasEpisode(v, ctx.episode) && player.playWith(ctx, variantRelease(v))}
                    />
                  ))}
                  <p className="flex items-center text-3xl font-semibold text-muted" style={{ height: HEAD_H }}>
                    {t("sources.group.torrents")}
                  </p>
                </div>
              )}
              {list.isPending || refreshing ? (
                <Loading />
              ) : err && items.length === 0 ? (
                <p className="pt-10 text-4xl">
                  {err instanceof ApiError && err.code === "network_error" ? t("tv.offline") : err instanceof ApiError && err.status === 429 ? t("tv.refine.rate_limited") : t("catalog.tv.load_error")}
                </p>
              ) : items.length === 0 ? (
                <p className="pt-10 text-4xl">{t("player.no_releases")}</p>
              ) : (
                items.map((r, i) => (
                  <ReleaseRowView
                    key={r.id}
                    index={i}
                    release={r}
                    best={i === 0}
                    last={r.id === remembered}
                    failed={tried.includes(r.id)}
                    fit={judgeFit(fitInput(r), caps)}
                    heavy={heavyMbps(r, env)}
                    server={dlLabel(findDownload(downloads.data, { infoHash: r.info_hash, episodeId: ctx.episode_id }))}
                    locale={locale}
                    onFocus={() => setSel({ kind: "rel", i })}
                    onPress={() => player.playRelease(ctx, r)}
                    onLongPress={() => player.playWith(ctx, r)}
                  />
                ))
              )}
            </div>
          </div>
      </FocusLine>

      {editing && (
        <RefineScreen
          ctx={ctx}
          initial={refine}
          onSearch={(r) => {
            setRefine(r);
            setEditing(false);
          }}
          onClose={() => {
            setEditing(false);
            setTimeout(() => void setFocus("picker-refine"), 0);
          }}
        />
      )}
      <div className="absolute bottom-0 left-0 right-0 flex h-20 items-center justify-between bg-bg px-24 text-2xl text-muted">
        <span>{items.length > 0 ? t("player.tv.picker_hint") : ""}</span>
        {errors.length > 0 && <span className="truncate pl-10 text-accent">{t("player.indexer_errors", { list: errors.map((e) => e.indexer).join(", ") })}</span>}
      </div>
    </div>
  );
}

function Loading() {
  const { t } = useI18n();
  return (
    <div>
      <div className="flex items-center pb-8 text-3xl text-muted">
        <Spinner size={36} />
        <span className="ml-5">{t("player.searching")}</span>
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="tv-pulse mb-5 rounded-card bg-surface" style={{ height: ROW_H - 20 }} />
      ))}
    </div>
  );
}

function ReleaseRowView({
  index,
  release,
  best,
  last,
  failed,
  fit,
  heavy,
  server,
  locale,
  onFocus,
  onPress,
  onLongPress,
}: {
  index: number;
  release: Release;
  best: boolean;
  last: boolean;
  failed: boolean;
  /** How it fits this TV (fit.ts chips). */
  fit: Fit;
  /** «тяжёлая: 39 Мбит/с» (more than this TV's measured rate allows). */
  heavy?: number | null;
  /** Server download state («На сервере ✓»), if any. */
  server?: string | null;
  locale: string;
  onFocus: () => void;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { t } = useI18n();
  // OK plays on release; holding it opens "Play with…".
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; down: boolean; long: boolean }>({ down: false, long: false });
  useEffect(() => () => clearTimeout(hold.current.timer), []);
  const { ref, focused } = useFocusable({
    focusKey: `rel-${index}`,
    onFocus,
    onEnterPress: () => {
      const h = hold.current;
      if (h.down) return;
      h.down = true;
      h.long = false;
      h.timer = setTimeout(() => {
        h.long = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onEnterRelease: () => {
      const h = hold.current;
      clearTimeout(h.timer);
      const wasDown = h.down;
      h.down = false;
      if (wasDown && !h.long) onPress();
    },
  });
  const row = releaseRow(release, locale);
  const res4k = row.resolution === "4K";
  // The fit chips already explain codec / audio warnings.
  const covered = new Set(fitCoveredWarnings(fit).map((w) => (WARNING_KEYS as Record<string, string>)[w]));
  const warnings: string[] = row.warnings.filter((k) => !covered.has(k)).map((k) => t(k));
  return (
    <div
      ref={ref}
      role="button"
      data-release-id={release.id}
      onClick={onPress}
      className={`tv-release flex items-center rounded-card px-8 ${focused ? "is-focused" : ""} ${failed ? "opacity-50" : ""}`}
      style={{ height: ROW_H, marginBottom: ROW_GAP }}
    >
      <div
        className={`flex shrink-0 items-center justify-center rounded-control text-4xl font-bold ${res4k ? "bg-accent text-on-accent" : "bg-surface-2 text-text"}`}
        style={{ width: 170, height: 104 }}
      >
        {row.resolution}
      </div>
      <div className="ml-8 min-w-0 flex-1">
        <div className="flex items-center text-3xl font-semibold">
          {row.chips.length > 0 && <span className="truncate">{row.chips.join(" · ")}</span>}
          {best && <Badge className="bg-accent text-on-accent">{t("player.best_match")}</Badge>}
          {row.seasonPack && <Badge className="bg-text/10 text-text">{t("player.season_pack")}{row.scope ? ` ${row.scope}` : ""}</Badge>}
          {last && <Badge className="bg-ok text-on-accent">{t("player.tv.last_played")}</Badge>}
          {server && <Badge className="bg-text/10 text-text"><span data-on-server>{server}</span></Badge>}
          {heavy ? (
            <Badge className="bg-danger/80 text-white">
              <span data-heavy={heavy}>{t("tvplay.heavy", { mbps: heavy })}</span>
            </Badge>
          ) : null}
          {isUncertain(release) && (
            <Badge className="bg-danger/80 text-white">
              <span data-uncertain>⚠ {t("tv.refine.uncertain")}</span>
            </Badge>
          )}
        </div>
        <p className="mt-2 truncate text-2xl text-muted">
          {release.provider && (
            <span data-provider={release.provider.id} className="mr-3 rounded-lg border border-text/20 px-3 py-0.5 text-xl font-semibold uppercase tracking-wide text-text/70">
              {release.provider.name}
            </span>
          )}
          {row.voices.map((v) => (
            <span key={v} data-voiceover className="mr-3 rounded-lg bg-text/10 px-3 py-0.5 text-text">
              {v}
            </span>
          ))}
          {[row.languages, row.audio].filter(Boolean).join("  ·  ")}
          {row.languages || row.audio ? "  ·  " : ""}
          <span className="text-text/60">{release.title}</span>
        </p>
        {(fit.chips.length > 0 || warnings.length > 0) && (
          <p className="mt-2 truncate text-2xl">
            <FitLine fit={fit} />
            {warnings.length > 0 && (
              <span className="text-accent-strong">
                <span className="mr-2">⚠</span>
                {warnings.join(" · ")}
              </span>
            )}
          </p>
        )}
      </div>
      <div className="ml-8 shrink-0 text-right" style={{ width: 230 }}>
        <p className="text-3xl font-semibold">{row.size}</p>
        <p className={`mt-2 text-2xl ${row.seeders >= 5 ? "text-ok" : "text-accent-strong"}`}>▲ {t("player.seeders", { n: row.seeders })}</p>
      </div>
    </div>
  );
}

/** One online variant: OK plays it at once (no torrent preparation). */
function VariantRowView({
  index,
  variant: v,
  episode,
  last,
  failed,
  onFocus,
  onPress,
  onLongPress,
}: {
  index: number;
  variant: OnlineVariant;
  episode: number | null;
  last: boolean;
  failed: boolean;
  onFocus: () => void;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { t } = useI18n();
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; down: boolean; long: boolean }>({ down: false, long: false });
  useEffect(() => () => clearTimeout(hold.current.timer), []);
  const { ref, focused } = useFocusable({
    focusKey: `onl-${index}`,
    onFocus,
    onEnterPress: () => {
      const h = hold.current;
      if (h.down) return;
      h.down = true;
      h.long = false;
      h.timer = setTimeout(() => {
        h.long = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onEnterRelease: () => {
      const h = hold.current;
      clearTimeout(h.timer);
      const wasDown = h.down;
      h.down = false;
      if (wasDown && !h.long) onPress();
    },
  });
  const available = variantHasEpisode(v, episode);
  const eps =
    v.episode != null
      ? t("sources.variant.episode", { n: v.episode })
      : v.episodes.length > 0
        ? t("sources.variant.episodes", { list: episodeRanges(v.episodes) })
        : null;
  return (
    <div
      ref={ref}
      role="button"
      data-variant-id={v.id}
      data-preferred={v.preferred ? "1" : undefined}
      onClick={onPress}
      className={`tv-release flex items-center rounded-card px-8 ${focused ? "is-focused" : ""} ${failed || !available ? "opacity-50" : ""}`}
      style={{ height: ROW_H, marginBottom: ROW_GAP }}
    >
      <div
        className={`flex shrink-0 items-center justify-center rounded-control text-4xl font-bold ${v.preferred ? "bg-accent text-on-accent" : "bg-surface-2 text-text"}`}
        style={{ width: 170, height: 104 }}
      >
        {v.max_quality ? `${v.max_quality}p` : "▶"}
      </div>
      <div className="ml-8 min-w-0 flex-1">
        <div className="flex items-center text-3xl font-semibold">
          <span className="truncate" data-voice>
            {v.voice}
          </span>
          {v.preferred && <Badge className="bg-accent text-on-accent">★ {t("sources.variant.preferred")}</Badge>}
          {last && <Badge className="bg-ok text-on-accent">{t("player.tv.last_played")}</Badge>}
        </div>
        <p className="mt-2 truncate text-2xl text-muted">
          <span className="mr-3 rounded-lg border border-text/20 px-3 py-0.5 text-xl font-semibold uppercase tracking-wide text-text/70">{v.provider.name}</span>
          {[qualitiesLabel(v.qualities), v.format.toUpperCase(), eps, v.title].filter(Boolean).join("  ·  ")}
        </p>
        {!available && episode != null && <p className="mt-2 truncate text-2xl text-accent-strong">⚠ {t("sources.variant.no_episode", { n: episode })}</p>}
      </div>
      <div className="ml-8 shrink-0 text-right text-2xl text-ok" style={{ width: 230 }}>
        {t("sources.variant.online")}
      </div>
    </div>
  );
}

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`ml-5 shrink-0 rounded-full px-5 py-1 text-xl font-semibold ${className}`}>{children}</span>;
}
