// /watch/:sourceId — watch in this browser.
//   /watch/new?media&episode&s&e[&release][&t]  finds the best release for this
//   browser (or uses `release`), prepares a source, then replaces the URL with
//   /watch/<sourceId>?…; the first-load screen stays up throughout.
// The page owns: preparation, the browser-support pre-check, the resume
// prompt, the fallback screen ("try another release / open in an app / play
// on TV") and the next episode; Player owns the <video>.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientId } from "../devprefs/logic";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type PlaybackSource } from "@martytv/contracts";
import { episodeCode, hasMediaSource, hlsMode, imageUrl, isOnlineRelease, nextOnlineVariant, skipMode } from "@martytv/media-types";
import { loaderPick, matchInfoOf, useI18n } from "@martytv/ui";
import { api } from "../api";
import { fetchOnline } from "../play/sourcesApi";
import { useDevices } from "../queries";
import { useCatalogConfig, useCatalogLang, useMedia, useSeason } from "../catalog/queries";
import { SendToTvProvider } from "../remote/SendToTv";
import { PlayOnTvProvider, releaseSummary, usePlayOnTv } from "../play/PlayOnTv";
import { SlowTorrentBanner, useLiveTorrent, useSlowSource } from "./torrentLive";
import { apiErrorCode, createSource, releasesQuery, sourceKey, usePlaybackSource, useReleases } from "../play/queries";
import { sourceErrorMessage, type ReleaseTarget } from "../play/releases";
import { assessHere, assessSource, bestForBrowser, reasonTexts, thisBrowser, type BrowserSupport } from "../play/browserSupport";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useMediaProgress, useSettings, useThemeSync } from "../watch/queries";
import { formatClock } from "../watch/format";
import { ChevronLeft } from "../icons";
import { Fallback, type FallbackMode } from "./Fallback";
import { Loader } from "./Loader";
import { useLoadProgress } from "./Loader";
import { Player, type NextUpInfo } from "./Player";
import { usePlaybackBusy } from "../devprefs/speedtest";
import { decideStart, infoRefetchDelay, nextEpisode, packCovers, prevEpisode, parseT, stageOf, watchUrl, type ErrorKind, type LoadStage, type StartDecision } from "./logic";
import { audioLanguages, audioNeedsSwitch, chooseAudio, readAudioChoice } from "./audioChoice";
import { exitFullscreen, nativeAudioTracks } from "./media";
import { rememberedRefine } from "../play/refine";
import { compatFixes, noteCompatServer, readCompatPref, wantCompat, writeCompatPref, type CompatPref } from "./compat";

/** Releases already tried per title/episode in this tab ("Try another release" skips them). */
const tried = new Map<string, Set<string>>();
const triedFor = (key: string) => {
  let s = tried.get(key);
  if (!s) tried.set(key, (s = new Set()));
  return s;
};

const num = (v: string | null) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export function WatchPage() {
  const { sourceId = "new" } = useParams();
  const [params] = useSearchParams();
  const media = params.get("media") ?? "";
  const episode = params.get("episode");
  const attempt = params.get("try") ?? "0";
  return (
    <SendToTvProvider>
      <PlayOnTvProvider>
        {/* A new episode or a new attempt starts over (loader, decisions). */}
        <Watch key={`${media}|${episode ?? ""}|${attempt}`} sourceId={sourceId} params={params} />
      </PlayOnTvProvider>
    </SendToTvProvider>
  );
}

type Fail = { mode: FallbackMode; message: string; reasons: string[]; position: number };

function Watch({ sourceId, params }: { sourceId: string; params: URLSearchParams }) {
  // No background speed test while preparing / playing.
  usePlaybackBusy();
  useThemeSync();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const lang = useCatalogLang();
  const { profileId } = useActiveProfile();
  const settings = useSettings();
  const { data: cfg } = useCatalogConfig();
  const { data: devices } = useDevices();
  const { play: playOnTv, chooseRelease } = usePlayOnTv();

  const mediaId = params.get("media") ?? "";
  const episodeId = params.get("episode");
  const s = num(params.get("s"));
  const e = num(params.get("e"));
  const tParam = parseT(params.get("t"));
  const releaseParam = params.get("release");
  const attempt = Number(params.get("try") ?? "0") || 0;
  // «Сюрприз»: this load's own key (one pick per Watch instance — it is keyed per attempt).
  const [loadId] = useState(() => `${mediaId}|${episodeId ?? ""}|${attempt}|${Date.now()}`);
  const target: ReleaseTarget & { episode_id?: string } = useMemo(
    () => ({
      media_id: mediaId,
      ...(s != null && { season_number: s }),
      ...(e != null && { episode_number: e }),
      ...(episodeId && { episode_id: episodeId }),
    }),
    [mediaId, s, e, episodeId],
  );
  const triedKey = `${mediaId}|${episodeId ?? ""}`;

  // ------------------------------------------------------------ labels

  const m = useMedia(mediaId).data;
  const season = useSeason(mediaId, m?.kind === "series" && s != null ? s : null).data;
  const ep = season?.episodes.find((x) => x.episode_number === e) ?? null;
  const code = s != null && e != null ? episodeCode(s, e) : null;
  const title = m?.title ?? "";
  const subtitle = code ? [code, ep?.name].filter(Boolean).join(" · ") : null;
  const label = code ? `${title} · ${code}` : title;
  // TMDB minutes: the compat timeline's length until ffprobe reports the file's.
  const runtimeMin = (code ? ep?.runtime : null) ?? m?.runtime ?? null;

  useEffect(() => {
    if (title) document.title = `${label} — Cineko`;
    return () => {
      document.title = "Cineko";
    };
  }, [title, label]);

  // ------------------------------------------------------------ preparation (/watch/new)

  const [prep, setPrep] = useState<{ step: "resolving" | "creating" } | { step: "error"; code: string } | null>(null);
  const prepFor = useRef<string | null>(null);
  useEffect(() => {
    if (sourceId !== "new" || !mediaId) return;
    const runKey = location.key;
    if (prepFor.current === runKey) return;
    prepFor.current = runKey;
    void (async () => {
      let releaseId = releaseParam;
      try {
        if (!releaseId) {
          setPrep({ step: "resolving" });
          const list = await qc.fetchQuery(releasesQuery(target, profileId, lang, rememberedRefine(mediaId), { client_id: clientId() }));
          const best = bestForBrowser(list.items, assessHere, { tried: [...triedFor(triedKey)] }) ?? list.items[0] ?? null;
          if (!best) return setPrep({ step: "error", code: "no_releases" });
          releaseId = best.id;
        }
        setPrep({ step: "creating" });
        const src = await createSource({
          media_id: mediaId,
          release_id: releaseId,
          ...(episodeId && { episode_id: episodeId }),
          ...(profileId && { profile_id: profileId }),
        });
        qc.setQueryData(sourceKey(src.id), src);
        navigate(watchUrl(target, { sourceId: src.id, t: tParam, attempt }), { replace: true });
      } catch (err) {
        setPrep({ step: "error", code: apiErrorCode(err) });
      }
    })();
  }, [sourceId, mediaId, episodeId, releaseParam, location.key, qc, target, profileId, lang, triedKey, navigate, tParam, attempt]);

  // ------------------------------------------------------------ source

  const sourceQ = usePlaybackSource(sourceId !== "new" ? sourceId : null);
  const source = sourceQ.data ?? null;
  const ready = source?.status === "ready" && source.stream_url ? source : null;

  // ffprobe info is computed in the background after the source turns ready:
  // keep fetching it (backing off) until it's there: the audio codec decides
  // compat up front, and the tracks / duration feed the menu and the timeline.
  // A fresh torrent often needs a minute or more (one refetch at 2.5 s used to
  // give up: no sound, no tracks, no length in compat).
  const infoTries = useRef(0);
  const readyId = ready?.id ?? null;
  const hasInfo = !!ready?.media_info;
  const isTorrent = (ready?.kind ?? "torrent") === "torrent";
  const [infoTick, setInfoTick] = useState(0);
  // Stable (unlike the query result, which would restart the timer on every change).
  const refetchSource = sourceQ.refetch;
  useEffect(() => {
    if (!readyId || hasInfo || !isTorrent) return;
    const delay = infoRefetchDelay(infoTries.current);
    if (delay == null) return;
    const id = setTimeout(() => {
      infoTries.current += 1;
      void refetchSource().finally(() => setInfoTick((n) => n + 1));
    }, delay);
    return () => clearTimeout(id);
  }, [readyId, hasInfo, isTorrent, infoTick, refetchSource]);

  const support: BrowserSupport | null = useMemo(() => {
    if (!ready) return null;
    const { probe, env } = thisBrowser();
    return assessSource(ready, probe, env);
  }, [ready]);
  const [forced, setForced] = useState(false);
  /** The loader still covers the video (no first frame yet). */
  const [covered, setCovered] = useState(true);

  // ------------------------------------------------------------ compat stream

  useEffect(() => noteCompatServer(ready), [ready]);
  const [compatPref, setCompatPref] = useState<CompatPref>(readCompatPref);
  // null = automatic; true/false = the user's or the page's decision for this source.
  const [compatForced, setCompatForced] = useState<boolean | null>(null);
  /** Restart position after a fallback («Перекодировать звук…»). */
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const prefsQ = useQuery({
    queryKey: ["profile-prefs", profileId],
    queryFn: () => unwrap(api.GET("/profiles/{id}/preferences", { params: { path: { id: profileId! } } })),
    enabled: !!profileId,
    staleTime: 5 * 60_000,
  });
  // Voice: the profile's studios / languages, else the UI (= profile) language.
  const audioPrefs = useMemo(
    () => ({ voiceovers: prefsQ.data?.preferred_voiceovers ?? [], languages: audioLanguages(prefsQ.data?.preferred_audio_languages, locale) }),
    [prefsQ.data, locale],
  );
  // The preferred voice isn't the file's default and this browser can't switch
  // tracks: compat plays it. Only before the first frame — once watching, a
  // late ffprobe answer doesn't change the voice under the viewer.
  const audioSwitch = useMemo(
    () =>
      covered &&
      !!ready?.media_info &&
      audioNeedsSwitch(ready.media_info, chooseAudio(ready.media_info, audioPrefs, readAudioChoice(mediaId)), nativeAudioTracks()),
    [covered, ready, audioPrefs, mediaId],
  );
  const compatAuto = useMemo(
    () => wantCompat({ compatUrl: ready?.compat_url, pref: compatPref, support, audioSwitch }),
    [ready, compatPref, support, audioSwitch],
  );
  // Once on, stay on (ffprobe info arriving later must not flip it back).
  if (compatAuto && compatForced == null) setCompatForced(true);
  const compat = !!ready?.compat_url && (compatForced ?? compatAuto);

  // ------------------------------------------------------------ resume decision

  const progressQ = useMediaProgress(mediaId);
  const prog = episodeId ? (progressQ.data?.episodes.find((x) => x.episode_id === episodeId) ?? null) : (progressQ.data?.movie ?? null);
  const progressSettled = !profileId || progressQ.isSuccess || progressQ.isError;
  const [decision, setDecision] = useState<StartDecision | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  if (!decision && (tParam != null || progressSettled)) setDecision(decideStart(tParam, prog));
  const startAt = decision?.kind === "start" ? decision.at : chosen;
  const decided = tParam != null || progressQ.isSuccess;

  // ------------------------------------------------------------ loader

  const [metadata, setMetadata] = useState(false);
  const stage: LoadStage =
    sourceId === "new"
      ? prep?.step === "creating"
        ? "creating"
        : "resolving"
      : !covered
        ? "done"
        : stageOf("source", source);
  const p = useLoadProgress(stage, source, metadata);
  // The page's source query stops at "ready", yet most of the loading happens after it: live numbers.
  const loaderTorrent = useLiveTorrent(source, covered && stage !== "done");
  const slowLoad = useSlowSource(source, loaderTorrent, covered && stage !== "done" && stage !== "resolving", `${source?.id ?? ""}:${attempt}`);

  // ------------------------------------------------------------ fallback

  const [fail, setFail] = useState<Fail | null>(null);
  const [silent, setSilent] = useState(false);
  const [stale, setStale] = useState(false);
  const positionRef = useRef(tParam ?? 0);

  const fallbackFor = useCallback(
    (kind: ErrorKind | "silent", position: number) => {
      void exitFullscreen();
      const reasons = support ? reasonTexts(support, t) : [];
      const message =
        kind === "silent"
          ? t("player.web.fallback.silent_body")
          : kind === "network"
            ? t("player.web.fallback.network_body")
            : t("player.web.fallback.unsupported_body");
      setFail({ mode: kind === "aborted" ? "network" : kind, message, reasons, position });
    },
    [support, t],
  );

  let fallback: Fail | null = fail;
  if (!fallback && prep?.step === "error") {
    fallback = { mode: "prepare", message: sourceErrorMessage(prep.code, t), reasons: [], position: tParam ?? 0 };
  } else if (!fallback && source?.status === "error") {
    fallback = { mode: "source", message: sourceErrorMessage(source.error, t), reasons: [], position: tParam ?? 0 };
  } else if (!fallback && sourceQ.error && !source) {
    fallback = { mode: "source", message: sourceErrorMessage(apiErrorCode(sourceQ.error), t), reasons: [], position: tParam ?? 0 };
  } else if (!fallback && support?.verdict === "unlikely" && !forced && !(compat && compatFixes(support))) {
    fallback = { mode: "precheck", message: t("player.web.fallback.precheck_body"), reasons: reasonTexts(support, t), position: tParam ?? 0 };
  }

  // A release that failed here isn't picked again automatically.
  const failedRelease = fallback && fallback.mode !== "silent" ? (source?.release.id ?? null) : null;
  useEffect(() => {
    if (failedRelease) triedFor(triedKey).add(failedRelease);
  }, [failedRelease, triedKey]);

  // "Try another release (better for browsers)".
  const releases = useReleases(fallback || silent ? target : null, profileId, rememberedRefine(mediaId), { client_id: clientId() });
  const another = useMemo(() => {
    if (!fallback && !silent) return null;
    if (releases.isPending) return { loading: true, label: null, go: null };
    const items = releases.data?.items ?? [];
    const skip = [...triedFor(triedKey), ...(source ? [source.release.id] : [])];
    const next = bestForBrowser(items, assessHere, { tried: skip, avoid: support?.avoid ?? [] });
    if (!next) return { loading: false, label: null, go: null };
    return {
      loading: false,
      label: releaseSummary(next, locale),
      go: () => navigate(watchUrl(target, { release: next.id, t: Math.floor(positionRef.current), attempt: attempt + 1 }), { replace: true }),
    };
  }, [fallback, silent, releases.isPending, releases.data, triedKey, source, support, locale, navigate, target, attempt]);

  const onTv =
    devices && devices.length > 0
      ? () =>
          playOnTv({
            ...target,
            label,
            ...(source && { release_id: source.release.id }),
            position_seconds: Math.floor(positionRef.current),
          })
      : null;

  // ------------------------------------------------------------ next episode

  const nextSeasonNumber = useMemo(() => {
    if (!m || m.kind !== "series" || s == null) return null;
    return m.seasons.map((x) => x.season_number).filter((n) => n > s).sort((a, b) => a - b)[0] ?? null;
  }, [m, s]);
  const needNextSeason = !!season && e != null && !season.episodes.some((x) => x.episode_number > e);
  const nextSeason = useSeason(mediaId, needNextSeason ? nextSeasonNumber : null).data;
  const next: NextUpInfo | null = useMemo(() => {
    if (!m || m.kind !== "series" || s == null || e == null || !season) return null;
    const ref = nextEpisode({ season: s, episode: e }, season.episodes, m.seasons, nextSeason?.episodes);
    if (!ref?.id) return null;
    const keep = ready && packCovers(ready.release, ref.season, ref.episode) ? ready.release.id : undefined;
    const target = { media_id: mediaId, episode_id: ref.id, season_number: ref.season, episode_number: ref.episode };
    const prevRelease = ready?.release;
    return {
      code: episodeCode(ref.season, ref.episode),
      name: ref.name ?? null,
      go: () => {
        // Watched online: the episode stays online (same source and voice) when it's there.
        if (!keep && prevRelease && isOnlineRelease(prevRelease)) {
          void fetchOnline(target, profileId, lang)
            .then((l) => nextOnlineVariant(l.items, prevRelease, hlsMode(document.createElement("video"), hasMediaSource()))?.id)
            .catch(() => undefined)
            .then((id) => navigate(watchUrl(target, { release: id, t: 0 }), { replace: true }));
          return;
        }
        navigate(watchUrl(target, { release: keep, t: 0 }), { replace: true });
      },
    };
  }, [m, s, e, season, nextSeason, ready, navigate, mediaId, profileId, lang]);

  // ------------------------------------------------------------ previous episode

  const prevSeasonNumber = useMemo(() => {
    if (!m || m.kind !== "series" || s == null || s <= 1) return null;
    return m.seasons.map((x) => x.season_number).filter((n) => n > 0 && n < s).sort((a, b) => b - a)[0] ?? null;
  }, [m, s]);
  const needPrevSeason = !!season && e != null && !season.episodes.some((x) => x.episode_number < e);
  const prevSeason = useSeason(mediaId, needPrevSeason ? prevSeasonNumber : null).data;
  const prev: NextUpInfo | null = useMemo(() => {
    if (!m || m.kind !== "series" || s == null || e == null || !season) return null;
    const ref = prevEpisode({ season: s, episode: e }, season.episodes, m.seasons, prevSeason?.episodes);
    if (!ref?.id) return null;
    const keep = ready && packCovers(ready.release, ref.season, ref.episode) ? ready.release.id : undefined;
    const target = { media_id: mediaId, episode_id: ref.id, season_number: ref.season, episode_number: ref.episode };
    const prevRelease = ready?.release;
    return {
      code: episodeCode(ref.season, ref.episode),
      name: ref.name ?? null,
      go: () => {
        // Watched online: the episode stays online (same source and voice) when it's there.
        if (!keep && prevRelease && isOnlineRelease(prevRelease)) {
          void fetchOnline(target, profileId, lang)
            .then((l) => nextOnlineVariant(l.items, prevRelease, hlsMode(document.createElement("video"), hasMediaSource()))?.id)
            .catch(() => undefined)
            .then((id) => navigate(watchUrl(target, { release: id, t: 0 }), { replace: true }));
          return;
        }
        navigate(watchUrl(target, { release: keep, t: 0 }), { replace: true });
      },
    };
  }, [m, s, e, season, prevSeason, ready, navigate, mediaId, profileId, lang]);

  // ------------------------------------------------------------ leaving

  const back = useCallback(() => {
    if (location.key !== "default") navigate(-1);
    else navigate(`/title/${mediaId}${s != null && e != null ? `?season=${s}&episode=${e}` : ""}`, { replace: true });
  }, [location.key, navigate, mediaId, s, e]);

  // Watch state changed: titles, rows and history refresh when we leave.
  useEffect(
    () => () => {
      void qc.invalidateQueries({ queryKey: ["progress", mediaId] });
      void qc.invalidateQueries({ queryKey: ["continue"] });
      void qc.invalidateQueries({ queryKey: ["history"] });
      void qc.invalidateQueries({ queryKey: ["media", mediaId] });
    },
    [qc, mediaId],
  );

  const refresh = useCallback(async (): Promise<PlaybackSource | null> => {
    if (!ready) return null;
    const fresh = await unwrap(api.GET("/playback/sources/{id}", { params: { path: { id: ready.id } } }));
    qc.setQueryData(sourceKey(fresh.id), fresh);
    return fresh.status === "ready" ? fresh : null;
  }, [ready, qc]);

  // ------------------------------------------------------------ render

  const poster = imageUrl(cfg, m?.poster_path, "w500");
  const backdrop = imageUrl(cfg, m?.backdrop_path, "w1280");
  // "No sound" keeps the player mounted (paused) so "Keep watching" continues in place.
  const playerSource = ready && (!fallback || fallback.mode === "silent") ? ready : null;

  return (
    <div className="fixed inset-0 bg-black" data-testid="watch-page">
      {playerSource && (
        <Player
          key={playerSource.id}
          source={playerSource}
          title={title}
          subtitle={subtitle}
          poster={poster}
          startAt={resumeAt ?? startAt}
          decided={decided}
          covered={covered}
          hold={!!fallback}
          session={profileId ? { profile_id: profileId, media_id: mediaId, episode_id: episodeId } : null}
          refresh={refresh}
          onSourceChange={(fresh) => qc.setQueryData(sourceKey(fresh.id), fresh)}
          onMetadata={() => setMetadata(true)}
          onFirstFrame={() => setCovered(false)}
          onFatal={(kind, pos) => {
            // The browser can't open this file: retry once through the server's
            // compat stream (e.g. MKV in Safari / the iPad's MSX web view).
            if ((kind === "unsupported" || kind === "decode") && ready?.compat_url && !compat && compatPref !== "off") {
              setResumeAt(pos);
              setForced(true);
              setCompatForced(true);
            } else fallbackFor(kind, pos);
          }}
          onSilent={() => {
            // No sound: switch to the compat stream when the server has one.
            if (ready?.compat_url && compatPref !== "off" && !compat) setCompatForced(true);
            else setSilent(true);
          }}
          compat={compat}
          onCompatToggle={(on) => {
            const p: CompatPref = on ? "on" : "off";
            writeCompatPref(p);
            setCompatPref(p);
            setCompatForced(on);
          }}
          audioPrefs={audioPrefs}
          audioKey={mediaId}
          onCompatAudio={() => {
            // A track the original stream can't switch to: compat for this source only.
            if (!ready?.compat_url || compat) return;
            setForced(true);
            setCompatForced(true);
          }}
          runtimeSeconds={runtimeMin ? runtimeMin * 60 : null}
          onLighter={(rate) =>
            chooseRelease({
              ...target,
              label,
              position_seconds: Math.floor(positionRef.current),
              ...(ready?.media_info?.duration_seconds && { budget: { bps: rate, duration_seconds: ready.media_info.duration_seconds } }),
            })
          }
          onEnded={() => {
            void qc.invalidateQueries({ queryKey: ["progress", mediaId] });
            void qc.invalidateQueries({ queryKey: ["continue"] });
          }}
          onStale={() => setStale(true)}
          onBack={back}
          positionRef={positionRef}
          next={next}
          prev={prev}
          autoplayNext={settings.autoplay_next_episode}
          autoplayCountdown={settings.autoplay_countdown ?? true}
          skipMode={skipMode(settings.skip_segments)}
        >
          {silent && !fallback && (
            <Banner
              testId="silent-banner"
              text={t("player.web.silent_banner", { codec: support?.reasons.find((r) => r.code === "no_audio")?.label ?? "" })}
              actions={[
                { label: t("player.web.fix_sound"), onClick: () => fallbackFor("silent", positionRef.current) },
                { label: t("common.close"), onClick: () => setSilent(false) },
              ]}
            />
          )}
          {stale && <Banner testId="stale-banner" text={t("player.web.stale")} actions={[{ label: t("common.close"), onClick: () => setStale(false) }]} />}
        </Player>
      )}

      {covered && !fallback && (
        <Loader
          style={loaderPick.resolve(settings.loading_style, loadId, () => matchInfoOf(mediaId, m))}
          m={{
            p,
            stage,
            title,
            subtitle,
            poster,
            backdrop,
            torrent: loaderTorrent,
            fileBytes: source?.file?.size_bytes ?? source?.release.size_bytes ?? null,
            online: !!source && source.kind === "online",
            quality: !source
              ? null
              : source.kind === "online"
                ? [source.quality ? `${source.quality}p` : null, source.release.title, source.provider?.name].filter(Boolean).join(" · ")
                : releaseSummary(source.release, locale),
          }}
        >
          <button
            type="button"
            onClick={back}
            aria-label={t("player.web.back")}
            className="absolute left-[max(env(safe-area-inset-left),0.5rem)] top-[max(env(safe-area-inset-top),0.5rem)] flex h-11 w-11 items-center justify-center rounded-full text-2xl text-text/80 hover:bg-surface-2"
            data-testid="loader-back"
          >
            <ChevronLeft />
          </button>
          {slowLoad.slow && (
            <div className="absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom),1rem)] z-20 flex justify-center px-3">
              <SlowTorrentBanner
                slow={slowLoad.slow}
                onWait={slowLoad.wait}
                onAnother={() =>
                  chooseRelease({
                    ...target,
                    label,
                    position_seconds: Math.floor(positionRef.current),
                    ...(source?.media_info?.duration_seconds && { budget: { bps: slowLoad.slow!.speedBps * 8, duration_seconds: source.media_info.duration_seconds } }),
                  })
                }
              />
            </div>
          )}
          {decision?.kind === "ask" && chosen == null && (
            <ResumePrompt
              at={decision.at}
              onResume={() => setChosen(decision.at)}
              onStartOver={() => setChosen(0)}
            />
          )}
        </Loader>
      )}

      {fallback && (
        <Fallback
          mode={fallback.mode}
          message={fallback.message}
          reasons={fallback.reasons}
          source={ready}
          title={label}
          another={another}
          onTv={onTv}
          onChoose={fallback.mode === "prepare" || fallback.mode === "source" ? () => chooseRelease({ ...target, label }) : undefined}
          onTryAnyway={fallback.mode === "precheck" ? () => setForced(true) : undefined}
          onCompat={
            ready?.compat_url && !compat && ["unsupported", "decode", "network", "silent", "precheck"].includes(fallback.mode)
              ? () => {
                  if (fail) setResumeAt(fail.position);
                  setFail(null);
                  setSilent(false);
                  setForced(true);
                  setCompatForced(true);
                }
              : undefined
          }
          onContinue={
            fallback.mode === "silent"
              ? () => {
                  setFail(null);
                  setSilent(false);
                }
              : undefined
          }
          onBack={back}
        />
      )}
    </div>
  );
}

function ResumePrompt({ at, onResume, onStartOver }: { at: number; onResume: () => void; onStartOver: () => void }) {
  const { t } = useI18n();
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-[max(env(safe-area-inset-bottom),1.25rem)]">
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-surface/95 p-4 shadow-2xl shadow-black/40 backdrop-blur"
        role="dialog"
        aria-label={t("player.web.resume_title")}
        data-testid="resume-prompt"
      >
        <p className="text-sm font-semibold text-muted">{t("player.web.resume_title")}</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            autoFocus
            onClick={onResume}
            data-testid="resume-yes"
            className="min-h-[48px] rounded-xl bg-accent px-3 font-bold text-on-accent hover:bg-accent-strong"
          >
            {t("watch.resume_at", { time: formatClock(at) })}
          </button>
          <button
            type="button"
            onClick={onStartOver}
            data-testid="resume-start-over"
            className="min-h-[48px] rounded-xl border border-border bg-surface-2 px-3 font-semibold hover:border-accent"
          >
            {t("watch.start_over")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Banner({ text, actions, testId }: { text: string; actions: { label: string; onClick: () => void }[]; testId: string }) {
  return (
    <div className="absolute inset-x-0 top-[calc(max(env(safe-area-inset-top),0.5rem)+3.5rem)] z-20 flex justify-center px-3">
      <div
        role="status"
        data-testid={testId}
        className="flex w-full max-w-lg flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-white/10 bg-neutral-900/95 px-4 py-2.5 text-sm text-white shadow-2xl backdrop-blur"
      >
        <span className="min-w-0 flex-1">{text}</span>
        <span className="flex gap-1">
          {actions.map((a) => (
            <button key={a.label} type="button" onClick={a.onClick} className="min-h-[36px] rounded-lg px-2.5 font-semibold text-accent hover:bg-white/10">
              {a.label}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
