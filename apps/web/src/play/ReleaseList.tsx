import { preferUnderRate } from "../player/logic";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Release } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { Button, ErrorText, timeAgo } from "../components";
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, CastIcon, DeviceIcon, PlayIcon, RefreshIcon, SearchIcon, TvIcon } from "../icons";
import { isRefined, rememberedRefine, rememberRefine, type Refine } from "./refine";
import { RefineSheet, useRefineTitle } from "./RefineSheet";
import { assessHere, bestForBrowser, rankForBrowser, reasonTexts, verdictLabel, type BrowserSupport } from "./browserSupport";
import { useReleases, useRefreshReleases } from "./queries";
import { OnlineGroup } from "./OnlineGroup";
import { capsFromAuto, constraintText, fitCoveredWarnings, fitInput, hintThroughput, judgeFit, networkHint, networkHintText, type Constraint, type Fit, releaseFormat, releaseFormatText } from "@martytv/media-types";
import { useDevicePrefs } from "../devprefs/queries";
import { FitChips } from "./FitChips";
import { useDevices } from "../queries";
import { capFromConstraints, clientId, heavyMbps, looseT, readSampleList } from "../devprefs/logic";
import { usePlaybackBusy } from "../devprefs/speedtest";
import { isTorrentRelease } from "../downloads/format";
import { ServerDownloadIcon } from "../downloads/ui";
import { PhoneIcon } from "../offline/ui";
import {
  applyFilters,
  audioCodecsLabel,
  codecLabel,
  confidencePct,
  coverageLabel,
  filterOptions,
  formatSize,
  hdrLabel,
  languageCode,
  languageName,
  voiceoverLabel,
  NO_FILTERS,
  qualityLabel,
  resolutionLabel,
  sanitizeFilters,
  warningLabels,
  type RankFor,
  type ReleaseFilters,
  type ReleaseTarget,
} from "./releases";

/** Seconds since the calling component mounted, ticking once a second. */
function useElapsed() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.floor((now - start) / 1000);
}

/** Searches take 10–25 s: show that something is happening, and for how long. */
function Searching() {
  const { t } = useI18n();
  const elapsed = useElapsed();
  return (
    <div className="space-y-4" aria-busy data-testid="releases-loading">
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3.5">
        <Spinner size={22} />
        <div className="min-w-0">
          <p className="font-semibold">
            {t("player.searching")}
            {elapsed > 0 && <span className="ml-1.5 font-normal tabular-nums text-muted">{t("player.elapsed", { s: elapsed })}</span>}
          </p>
          <p className="text-sm text-muted">{t(elapsed >= 8 ? "player.searching_slow" : "player.searching_hint")}</p>
        </div>
      </div>
      <ul className="space-y-2.5">
        {[0, 1, 2].map((i) => (
          <li key={i} className="h-[104px] animate-pulse rounded-2xl bg-surface-2/60" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </ul>
    </div>
  );
}

export type ReleaseMode = "tv" | "here";
const MODE_KEY = "martytv.release_mode";

function readMode(): ReleaseMode {
  try {
    return localStorage.getItem(MODE_KEY) === "here" ? "here" : "tv";
  } catch {
    return "tv";
  }
}

function writeMode(m: ReleaseMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // private mode
  }
}

/**
 * Ranked releases for a title / episode with quick filters. Picking a row calls
 * `onPick`; `currentId` marks the release that is playing now (source switcher).
 * With `onWatchHere` a "Rank for: TV | This browser" switch appears: in browser
 * mode rows carry a compatibility badge, releases that play here come first,
 * and picking a row watches it here.
 */
export function ReleaseList(props: {
  target: ReleaseTarget;
  profileId: string | undefined;
  profileName?: string | null;
  currentId?: string | null;
  onPick: (r: Release) => void;
  /** "Play with…": pick the TV player explicitly. */
  onPickWith?: (r: Release) => void;
  /** Play on this phone/computer (VLC, playlist…). */
  onPlayHere?: (r: Release) => void;
  /** Watch in this browser. */
  onWatchHere?: (r: Release) => void;
  /** «Скачать на сервер» (torrent releases). */
  onDownload?: (r: Release) => void;
  /** «На устройство»: save this release in the browser (torrent releases). */
  onSaveDevice?: (r: Release) => void;
  /** Lighter-release mode: browser ranking, releases under this rate first. */
  budget?: { bps: number; duration_seconds: number };
  /** The TV the list is for (its playback profile ranks the TV mode). */
  deviceId?: string | null;
}) {
  const [refine, setRefineState] = useState<Refine>(() => rememberedRefine(props.target.media_id));
  const [refining, setRefining] = useState(false);
  const title = useRefineTitle(props.target.media_id, props.target.season_number);
  // No background speed test while picking / preparing a stream.
  usePlaybackBusy();
  const setRefine = (r: Refine) => {
    rememberRefine(props.target.media_id, r);
    setRefineState(r);
    setRefining(false);
  };
  return (
    <>
      <ReleaseListBody {...props} refine={refine} onRefine={() => setRefining(true)} onResetRefine={() => setRefine({ q: null, loose: false })} />
      {refining && <RefineSheet title={title} value={refine} onApply={setRefine} onClose={() => setRefining(false)} />}
    </>
  );
}

type ListProps = Parameters<typeof ReleaseList>[0];

function ReleaseListBody({
  target,
  profileId,
  profileName,
  currentId,
  onPick,
  onPickWith,
  onPlayHere,
  onWatchHere,
  onDownload,
  onSaveDevice,
  budget,
  deviceId,
  refine,
  onRefine,
  onResetRefine,
}: ListProps & { refine: Refine; onRefine: () => void; onResetRefine: () => void }) {
  const { t, locale } = useI18n();
  const [mode, setModeState] = useState<ReleaseMode>(() => (onWatchHere ? (budget ? "here" : readMode()) : "tv"));
  const here = !!onWatchHere && mode === "here";
  const setMode = (m: ReleaseMode) => {
    setModeState(m);
    writeMode(m);
  };
  // Whose playback profile ranks the list: this browser, or the TV when the
  // user may read its profile (owner / `use`; others would get a 404).
  const { data: devices } = useDevices();
  const [showAll, setShowAll] = useState(false);
  const tv = deviceId ? devices?.find((d) => d.id === deviceId && (d.access === "owner" || d.access === "use")) : undefined;
  const rank: RankFor = here ? { client_id: clientId(), all: showAll } : tv ? { device_id: tv.id, all: showAll } : {};
  const list = useReleases(target, profileId, refine, rank);
  // TV mode: «✓ Пойдёт на Living Room» / «✗ Видео HEVC не поддерживается» from what that TV reported.
  const tvPrefs = useDevicePrefs(tv?.id ?? "", !here && !!tv);
  const tvAuto = tvPrefs.data?.auto;
  const refresh = useRefreshReleases(target, profileId, refine, rank);
  const fit = list.data?.device ?? null;
  const fitText = fit?.constraints.map((c) => constraintText(c as Constraint, looseT(t))).join(", ") ?? "";
  const capBps = capFromConstraints(fit?.constraints);
  // «Сеть сейчас ~8 Мбит/с — без рывков пойдут 1080p до ~4 ГБ» (this browser's recent measurement).
  const [netBps] = useState(() => hintThroughput(readSampleList(), Date.now()));
  const [rawFilters, setFilters] = useState<ReleaseFilters>(NO_FILTERS);
  const searching = list.isPending || refresh.isPending;

  const items = list.data?.items ?? [];
  const net = here ? networkHint(items, netBps) : null;
  const filters = sanitizeFilters(items, rawFilters);
  const filtered = applyFilters(items, filters);
  const opts = filterOptions(items);
  // Browser verdicts are only computed in browser mode (they probe the engine).
  const data = list.data;
  const verdicts = useMemo(() => (here && data ? new Map(data.items.map((r) => [r.id, assessHere(r)])) : null), [here, data]);
  const ranked = verdicts ? rankForBrowser(filtered, (r) => verdicts.get(r.id)!).map((x) => x.release) : filtered;
  // Lighter-release mode: what the measured connection can carry comes first.
  const light = budget && budget.duration_seconds > 0 ? (rs: Release[]) => preferUnderRate(rs, budget.bps, budget.duration_seconds) : null;
  const shown = light ? light(ranked) : ranked;
  const bestId = verdicts
    ? bestForBrowser(light ? light(items) : items, (r) => verdicts.get(r.id)!)?.id
    : items[0]?.id;
  const noneHere = !!verdicts && items.length > 0 && !bestId;
  const fits = useMemo(() => {
    if (here || !tv || !tvAuto || !data) return null;
    const caps = capsFromAuto(tvAuto, tv.name);
    return new Map(data.items.map((r) => [r.id, judgeFit(fitInput(r), caps)]));
  }, [here, tv, tvAuto, data]);
  const errors = list.data?.indexer_errors ?? [];

  // Online/anime variants (fast) come first and don't wait for the torrent search.
  const online = (
    <OnlineGroup
      target={target}
      profileId={profileId}
      here={here}
      currentId={currentId}
      onPick={onPick}
      onPickWith={onPickWith}
      onWatchHere={onWatchHere}
    />
  );

  if (searching) {
    return (
      <div className="space-y-3">
        {online}
        <Searching />
      </div>
    );
  }

  if (list.error && !list.data) {
    return (
      <div className="space-y-3">
      {online}
      <div className="space-y-3 py-2 text-center" data-testid="releases-error">
        <ErrorText error={list.error} />
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" onClick={() => refresh.mutate()}>
            <RefreshIcon />
            {t("player.retry_search")}
          </Button>
          <Button variant="secondary" onClick={onRefine} data-testid="releases-refine-error">
            <SearchIcon />
            {t("player.refine.button")}
          </Button>
          {isRefined(refine) && (
            <Button variant="ghost" onClick={onResetRefine}>
              {t("player.refine.reset")}
            </Button>
          )}
        </div>
      </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="releases">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {profileName && <span>{t("player.ranked_for", { name: profileName })}</span>}
        {list.data && (
          <span>
            {t(list.data.cached ? "player.searched_cached" : "player.searched", {
              when: timeAgo(list.data.searched_at, locale),
            })}
          </span>
        )}
        <span className="ml-auto flex items-center">
          <button
            type="button"
            onClick={onRefine}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2 font-semibold text-accent hover:bg-surface-2"
            data-testid="releases-refine"
          >
            <SearchIcon />
            {t("player.refine.button")}
          </button>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2 font-semibold text-accent hover:bg-surface-2"
            data-testid="releases-refresh"
          >
            <RefreshIcon />
            {t("player.retry_search")}
          </button>
        </span>
      </div>
      {isRefined(refine) && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-accent/10 px-3 py-2 text-sm" data-testid="refine-active">
          <SearchIcon className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 break-words">
            {refine.q ? t("player.refine.active", { q: refine.q }) : t("player.refine.active_auto")}
            {refine.loose && <span className="text-muted"> · {t("player.refine.loose_short")}</span>}
          </span>
          <button type="button" onClick={onRefine} className="min-h-[32px] rounded-lg px-2 font-semibold text-accent hover:bg-surface-2">
            {t("player.refine.edit")}
          </button>
          <button type="button" onClick={onResetRefine} className="min-h-[32px] rounded-lg px-2 font-semibold text-muted hover:bg-surface-2 hover:text-text" data-testid="refine-clear">
            {t("player.refine.reset")}
          </button>
        </div>
      )}
      <ErrorText error={refresh.error} />
      {((fit && fitText) || (showAll && (rank.client_id || rank.device_id))) && (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-2/70 px-3 py-1.5 text-xs"
          data-testid="device-fit"
          data-kind={fit?.kind}
          title={fit?.kind === "device" ? t("devprefs.ranked_tv", { name: fit.name }) : undefined}
        >
          {!showAll && fit && <span className="min-w-0 flex-1 text-text/85">{fit.kind === "device" && fit.name ? t("tvplay.picked_for_named", { name: fit.name, list: fitText }) : t("tvplay.picked_for", { list: fitText })}</span>}
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="ml-auto min-h-[32px] rounded-lg px-2 font-semibold text-accent hover:bg-surface"
            data-testid="device-fit-toggle"
          >
            {showAll ? t("tvplay.show_fit") : t("tvplay.show_all")}
          </button>
        </div>
      )}

      {here && !budget && net && (
        <p className="rounded-xl bg-surface-2/70 px-3 py-1.5 text-xs text-text/85" data-testid="network-hint" data-mbps={net.mbps}>
          {networkHintText(net, looseT(t))}
        </p>
      )}

      {errors.length > 0 && (
        <p className="flex gap-2 rounded-xl bg-accent/10 px-3 py-2 text-xs text-accent" data-testid="indexer-errors">
          <AlertIcon className="mt-px shrink-0 text-sm" />
          <span>{t("player.indexer_errors", { list: errors.map((e) => e.indexer).join(", ") })}</span>
        </p>
      )}

      {onWatchHere && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="release-mode">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">{t("player.web.mode_label")}</span>
          <div role="radiogroup" aria-label={t("player.web.mode_label")} className="inline-flex rounded-full border border-border bg-bg/40 p-0.5">
            {(["tv", "here"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                data-mode={m}
                onClick={() => setMode(m)}
                className={`flex min-h-[34px] items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition ${
                  mode === m ? "bg-accent text-on-accent" : "text-text/80 hover:text-text"
                }`}
              >
                {m === "tv" ? <TvIcon className="text-[15px]" /> : <DeviceIcon className="text-[15px]" />}
                {t(m === "tv" ? "player.web.mode.tv" : "player.web.mode.here")}
              </button>
            ))}
          </div>
          {here && <span className="text-xs text-muted">{t("player.web.mode_hint")}</span>}
        </div>
      )}
      {online}

      {noneHere && (
        <p className="flex gap-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="none-here">
          <AlertIcon className="mt-px shrink-0 text-sm" />
          <span>{t("player.web.none_here")}</span>
        </p>
      )}

      {items.length > 0 && (opts.resolutions.length > 1 || opts.languages.length > 1) && (
        <div className="space-y-2" data-testid="release-filters">
          {opts.resolutions.length > 1 && (
            <ChipRow
              label={t("player.filter_resolution")}
              value={filters.resolution}
              options={opts.resolutions.map((r) => ({ value: r, label: resolutionLabel(r) ?? r }))}
              onChange={(resolution) => setFilters({ ...filters, resolution })}
            />
          )}
          {opts.languages.length > 1 && (
            <ChipRow
              label={t("player.filter_language")}
              value={filters.language}
              options={opts.languages.map((l) => ({ value: l, label: languageCode(l), title: languageName(l, locale) }))}
              onChange={(language) => setFilters({ ...filters, language })}
            />
          )}
        </div>
      )}

      {!items.length ? (
        <div className="space-y-2 rounded-2xl border border-dashed border-border px-4 py-8 text-center" data-testid="releases-empty">
          <p className="font-semibold">{t("player.no_releases")}</p>
          <p className="text-sm text-muted">{isRefined(refine) ? t("player.refine.empty_hint") : t("player.no_releases_hint")}</p>
          <Button className="mt-2" onClick={onRefine} data-testid="releases-refine-empty">
            <SearchIcon />
            {t("player.refine.cta")}
          </Button>
        </div>
      ) : !shown.length ? (
        <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
          <p>{t("player.no_filtered")}</p>
          <button type="button" className="mt-2 min-h-[40px] font-semibold text-accent" onClick={() => setFilters(NO_FILTERS)}>
            {t("player.clear_filters")}
          </button>
        </div>
      ) : (
        <ul className="space-y-2.5" data-testid="release-rows">
          {shown.map((r) => (
            <li key={r.id}>
              <ReleaseRow
                r={r}
                best={r.id === bestId}
                current={r.id === currentId}
                support={verdicts?.get(r.id)}
                fit={fits?.get(r.id)}
                capBps={capBps}
                onPick={here ? () => onWatchHere!(r) : () => onPick(r)}
                onPickWith={here ? () => onPick(r) : onPickWith && (() => onPickWith(r))}
                pickWithTv={here}
                onPlayHere={onPlayHere && (() => onPlayHere(r))}
                onWatchHere={!here && onWatchHere ? () => onWatchHere(r) : undefined}
                onDownload={onDownload && isTorrentRelease(r) ? () => onDownload(r) : undefined}
                onSaveDevice={onSaveDevice && isTorrentRelease(r) ? () => onSaveDevice(r) : undefined}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChipRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string; title?: string }[];
  onChange: (v: string | null) => void;
}) {
  const { t } = useI18n();
  const all = [{ value: null as string | null, label: t("player.filter_all"), title: undefined }, ...options];
  return (
    <div role="group" aria-label={label} className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 md:-mx-5 md:px-5">
      <span className="mr-1 shrink-0 text-xs font-semibold uppercase tracking-wider text-muted">{label}</span>
      {all.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value ?? "all"}
            type="button"
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`min-h-[36px] shrink-0 rounded-full border px-3 text-sm font-semibold transition ${
              on ? "border-accent bg-accent text-on-accent" : "border-border bg-bg/40 text-text/85 hover:border-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Badge({ children, tone = "plain", title }: { children: ReactNode; tone?: "plain" | "strong" | "hdr" | "warn"; title?: string }) {
  const cls = {
    plain: "border-border bg-surface-2 text-text/85",
    strong: "border-text/20 bg-text text-on-accent",
    hdr: "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200",
    warn: "border-accent/30 bg-accent/10 text-accent",
  }[tone];
  return (
    <span title={title} className={`inline-flex h-6 items-center whitespace-nowrap rounded-md border px-1.5 text-[11px] font-bold tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

/** Which source found a release ("Prowlarr" / "Jacred"). */
export function ProviderChip({ name }: { name: string }) {
  const { t } = useI18n();
  return (
    <span
      title={t("sources.chip_title", { name })}
      data-testid="provider-chip"
      className="inline-flex h-[18px] items-center rounded border border-border bg-surface-2 px-1 text-[10px] font-bold uppercase tracking-wide text-text/70"
    >
      {name}
    </span>
  );
}

const VERDICT_TONE = {
  playable: "border-ok/40 bg-ok/10 text-ok",
  maybe: "border-accent/40 bg-accent/10 text-accent",
  unlikely: "border-danger/40 bg-danger/10 text-danger",
} as const;

/** "Plays in this browser" / "May lack sound" / "Won't play here" with the reasons. */
export function BrowserBadge({ support }: { support: BrowserSupport }) {
  const { t } = useI18n();
  const reasons = reasonTexts(support, t);
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] font-bold tracking-wide ${VERDICT_TONE[support.verdict]}`}
      title={reasons.join("\n") || undefined}
      data-testid="browser-badge"
      data-verdict={support.verdict}
    >
      {support.verdict === "playable" ? <PlayIcon className="text-[11px]" /> : <AlertIcon className="text-[12px]" />}
      {verdictLabel(support, t)}
    </span>
  );
}

export function ReleaseRow({
  r,
  best,
  current,
  support,
  fit,
  capBps = null,
  onPick,
  onPickWith,
  pickWithTv,
  onPlayHere,
  onWatchHere,
  onDownload,
  onSaveDevice,
}: {
  r: Release;
  best?: boolean;
  current?: boolean;
  /** Browser mode: this browser's verdict. */
  support?: BrowserSupport;
  /** TV mode: how this release fits the TV it goes to (its reported codecs / screen). */
  fit?: Fit;
  /** The device profile's bitrate cap (bits/s): heavier releases get «тяжёлая: N Мбит/с». */
  capBps?: number | null;
  onPick: () => void;
  onPickWith?: () => void;
  /** The secondary action is "Play on TV" (browser mode) instead of "Play with…". */
  pickWithTv?: boolean;
  onPlayHere?: () => void;
  /** TV mode: watch this one in the browser. */
  onWatchHere?: () => void;
  /** «Скачать на сервер (для медленных раздач)». */
  onDownload?: () => void;
  /** «На устройство» (offline in this browser). */
  onSaveDevice?: () => void;
}) {
  const { t, locale } = useI18n();
  const res = resolutionLabel(r.resolution);
  const hdr = hdrLabel(r.hdr);
  const quality = qualityLabel(r.source_quality);
  const codec = codecLabel(r.video_codec);
  const format = releaseFormat(r);
  const audio = audioCodecsLabel(r.audio_codecs);
  // Older cached search results may predate `voiceovers`.
  const voiceovers = r.voiceovers ?? [];
  const coverage = coverageLabel(r);
  const heavy = heavyMbps(r.est_bitrate_bps, capBps);
  // The fit chips already say «DTS → AAC» / «HEVC не поддерживается»: no second warning.
  const covered = fitCoveredWarnings(fit);
  // The «тяжёлая» chip carries the number: it replaces the generic warning.
  const warnings = [
    ...(heavy != null ? [t("tvplay.heavy", { mbps: heavy })] : []),
    ...warningLabels(r.warnings.filter((w) => !(heavy != null && w === "too_heavy_for_device") && !covered.includes(w)), t),
  ];
  const pct = confidencePct(r.confidence);

  const actions = !current && (onPickWith || onPlayHere || onWatchHere);
  const slow = r.seeders < 5;
  const why = support && support.verdict !== "playable" ? reasonTexts(support, t)[0] : null;
  return (
    <div
      data-testid="release-row"
      data-release-id={r.id}
      data-best={best ? "true" : undefined}
      className={`overflow-hidden rounded-2xl border transition focus-within:border-accent ${
        current
          ? "border-ok/50 bg-ok/5"
          : best
            ? "border-accent/60 bg-accent/[0.06] hover:border-accent"
            : "border-border bg-bg/40 hover:border-muted"
      }`}
    >
    <button
      type="button"
      onClick={onPick}
      disabled={current}
      data-testid="release-pick"
      className="block w-full p-3 text-left focus-visible:outline-none disabled:cursor-default"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {(best || current || support) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {(best || current) && (
                <p className={`text-[11px] font-bold uppercase tracking-wider ${current ? "text-ok" : "text-accent"}`}>
                  {current ? t("player.current_source") : t("player.best_match")}
                </p>
              )}
              {support && <BrowserBadge support={support} />}
            </div>
          )}
          {why && <p className="text-xs text-muted" data-testid="browser-reason">{why}</p>}
          {fit && fit.chips.length > 0 && <FitChips fit={fit} />}
          <div className="flex flex-wrap items-center gap-1">
            {res && <Badge tone="strong">{res}</Badge>}
            {hdr && <Badge tone="hdr">{hdr}</Badge>}
            {quality && <Badge tone={r.source_quality === "cam" || r.source_quality === "telesync" ? "warn" : "plain"}>{quality}</Badge>}
            {codec && <Badge>{codec}</Badge>}
            {format && (
              <Badge tone={format.label === "AVI" ? "warn" : "plain"}>
                <span data-testid="release-format" title={format.guess ? t("releases.format_guess") : undefined}>
                  {releaseFormatText(format)}
                </span>
              </Badge>
            )}
            {r.is_season_pack && <Badge>{t("player.season_pack")}</Badge>}
            {coverage && !r.is_season_pack && <Badge>{coverage}</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {voiceovers.length > 0 && (
              <span className="flex flex-wrap items-center gap-1" aria-label={t("player.voiceovers")} data-testid="voiceovers">
                {voiceovers.slice(0, 4).map((v, i) => (
                  <span
                    key={`${v.kind}-${v.studio}-${v.language}-${i}`}
                    title={languageName(v.language === "orig" ? "und" : v.language, locale)}
                    className={`rounded px-1.5 text-xs font-semibold ${
                      v.kind === "dub" ? "bg-accent/15 text-accent-strong" : "bg-surface-2 text-text/90"
                    }`}
                  >
                    {voiceoverLabel(v)}
                  </span>
                ))}
                {voiceovers.length > 4 && <span className="text-xs text-muted">+{voiceovers.length - 4}</span>}
              </span>
            )}
            {r.languages.length > 0 && (
              <span className="flex items-center gap-1" aria-label={t("player.audio")}>
                {r.languages.map((l) => (
                  <span key={l} title={languageName(l, locale)} className="rounded bg-surface-2 px-1 text-xs font-bold text-text/90">
                    {languageCode(l)}
                  </span>
                ))}
              </span>
            )}
            {audio && <span className="text-xs text-muted">{audio}</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-base font-bold tabular-nums">{formatSize(r.size_bytes, locale)}</p>
          <p className="mt-0.5 flex items-center justify-end gap-2 text-xs tabular-nums" title={t("player.seeders", { n: r.seeders })}>
            <span className={`flex items-center gap-0.5 font-semibold ${r.seeders >= 5 ? "text-ok" : r.seeders > 0 ? "text-accent" : "text-danger"}`}>
              <ArrowUpIcon className="text-[13px]" />
              {r.seeders}
            </span>
            {r.leechers != null && (
              <span className="flex items-center gap-0.5 text-muted">
                <ArrowDownIcon className="text-[13px]" />
                {r.leechers}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted" title={t("player.confidence_hint")}>
            {t("player.confidence", { pct })}
          </p>
        </div>
      </div>
      {warnings.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label={t("player.warnings")}>
          {warnings.map((w) => (
            <li key={w}>
              <Badge tone="warn">
                <AlertIcon className="mr-1 text-[12px]" />
                {w}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 break-words text-xs leading-snug text-muted [overflow-wrap:anywhere]" data-testid="release-title">
        {r.title}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted/80">
        {r.provider && <ProviderChip name={r.provider.name} />}
        <span>{[r.indexer, r.release_group, r.published_at ? timeAgo(r.published_at, locale) : null].filter(Boolean).join(" · ")}</span>
      </p>
    </button>
    {actions && (
      <div className="flex justify-end gap-1 border-t border-border/70 px-1.5 py-1">
        {onWatchHere && (
          <button
            type="button"
            onClick={onWatchHere}
            data-testid="release-watch-here"
            className="mr-auto flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-accent hover:bg-surface-2"
          >
            <PlayIcon className="text-sm" />
            {t("player.web.watch_here")}
          </button>
        )}
        {onPlayHere && (
          <button
            type="button"
            onClick={onPlayHere}
            data-testid="release-play-here"
            className="flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-text/80 hover:bg-surface-2 hover:text-text"
          >
            <DeviceIcon className="text-base" />
            {t("player.play_here")}
          </button>
        )}
        {onPickWith && (
          <button
            type="button"
            onClick={onPickWith}
            data-testid="release-play-with"
            className="flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-text/80 hover:bg-surface-2 hover:text-text"
          >
            <CastIcon className="text-base" />
            {pickWithTv ? t("player.play_on_tv") : t("player.play_with")}
          </button>
        )}
      </div>
    )}
    {(onDownload || onSaveDevice) && !current && (
      <div className="flex border-t border-border/70">
        {onSaveDevice && (
          <button
            type="button"
            onClick={onSaveDevice}
            data-testid="release-save-device"
            className="flex min-h-[40px] shrink-0 items-center gap-1.5 border-r border-border/70 px-3 text-left text-xs font-semibold text-text/75 hover:bg-surface-2 hover:text-text"
          >
            <PhoneIcon className="shrink-0 text-base text-accent" />
            {t("devicedl.release_save")}
          </button>
        )}
        {onDownload && (
          <button
            type="button"
            onClick={onDownload}
            data-testid="release-download"
            className={`flex min-h-[40px] min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-xs font-semibold hover:bg-surface-2 ${
              slow ? "text-accent" : "text-text/75 hover:text-text"
            }`}
          >
            <ServerDownloadIcon className="shrink-0 text-base" />
            <span className="min-w-0">
              {t("downloads.download_to_server")}
              <span className="font-normal text-muted"> · {t("downloads.for_slow")}</span>
            </span>
          </button>
        )}
      </div>
    )}
    </div>
  );
}
