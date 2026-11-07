import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  unwrap,
  type ConnectionState,
  type Device,
  type Envelope,
  type Episode,
  type MediaDetail,
  type Profile,
  type ContinueItem,
  type IptvChannel,
} from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { applyDesign, applyTheme, Centered, CV_OFFLINE, DESIGN_SWATCH, Logo, Spinner, useEffectiveDesign, useI18n } from "@martytv/ui";
import { api, onUnauthorized, realtime } from "./api";
import { credentialStore, exitApp, isBackKey, profileStore } from "./platform";
import { FocusButton, rememberFocus } from "./focus";
import { ActionMenu } from "./components/ActionMenu";
import { initialStack, openDetails, openSection, pop, type StackEntry } from "./catalog/nav";
import { queryClient } from "./catalog/queries";
import { pickSeason } from "./catalog/seasons";
import { CommandProcessor, type OpenRequest, type PlayerCommand, type PlayRequest, type Sender } from "./remote/commands";
import { buildDeviceState, stateKey, type DetailsInfo } from "./remote/state";
import { player } from "./player/controller";
import { useFlow } from "./player/flow";
import { LivePlayer, PlayerLayer, PlayerWait, VideoPlayer } from "./lazy";
import { flowScreen, type PlayContext } from "./player/session";
import { currentPlayers, defaultPlayerStore, resolvePlayer } from "./players/select";
import { devicePrefs } from "./settings/devicePrefs";
import { startSpeedtest } from "./settings/speedtest";
import { tvOwn, useTvOwnLanguage } from "./settings/tvOwn";
import { setHealthScreen, startHealth } from "./health/agent";
import { PairingScreen } from "./screens/PairingScreen";
import { TokenScreen } from "./screens/TokenScreen";
import { ProfilesScreen } from "./screens/ProfilesScreen";
import { CatalogShell, type PlayHow } from "./screens/catalog/CatalogShell";
import { activeProfile, settingsKey, themeCache, useLoadedSettings } from "./profile/settings";
import { MessageLayer } from "./messages/MessageLayer";
import { DesignProvider, DeviceProvider } from "./design/context";
import { runBackFirst } from "./design/topJump";
import { SkinBackground } from "./design/skins";
import { getLook, loadLook } from "./design/looks/registry";
import { parseMessageEvent } from "./messages/queue";
import { RateLayer } from "./watch/RatePrompt";
import { messageQueue } from "./watch/stores";
import { invalidateForYou } from "./foryou/queries";
import { askInbox, parseAskEvent } from "./foryou/askLogic";
import { live, liveControl, useLive } from "./iptv/live";
import { tvVolume } from "./player/volume";
import { VolumeOsd } from "./player/VolumeOsd";
import { findChannel } from "./iptv/queries";
import { programmeTitle } from "./iptv/logic";
import { useVideoSession, videoSession } from "./video/session";
import { videoPlaybackState, type VideoItem } from "./video/logic";
import { qualityInPlace, videoControl } from "./video/remote";
import { PillLayer } from "./design/PillDialog";
import { PausedSaver } from "./idle/PausedSaver";
import { introEnv, shouldShowIntro } from "./intro/logic";
import { preloadIntroScene } from "./intro/sceneImports";

// The startup animation is its own chunk: TVs with it switched off never fetch it.
const StartupIntro = lazy(() => import("./intro/StartupIntro").then((m) => ({ default: m.StartupIntro })));

type Screen =
  | { kind: "boot" }
  | { kind: "offline" }
  | { kind: "pairing" }
  | { kind: "token" }
  | { kind: "profiles"; device: Device; profiles: Profile[]; current?: Profile }
  | { kind: "home"; device: Device; profiles: Profile[]; profile: Profile };

/** A toast over any screen: messages and "opened from a phone" notices. */
interface Toast {
  label: string;
  text?: string;
  ms: number;
}

/** A media.open / media.play received on the profile picker, run once a profile is chosen. */
interface Pending {
  req: OpenRequest;
  play?: PlayRequest;
  sender: Sender;
  at: number;
}

/** How often the state is re-sent while playing (skipped when unchanged). */
const STATE_EVERY = 5000;
const PENDING_TTL = 5 * 60_000;

/** Which screen to open once we know the device and its profiles. */
function landing(device: Device, profiles: Profile[]): Screen {
  const remembered = profiles.find((p) => p.id === profileStore.get());
  const fallback = profiles.find((p) => p.id === device.default_profile_id);
  const pick = remembered ?? fallback;
  // A PIN-protected profile is never entered automatically.
  if (pick && !pick.has_pin) return { kind: "home", device, profiles, profile: pick };
  return { kind: "profiles", device, profiles };
}

const pauseForMessage = () => void player.pause();

export function App() {
  const [screen, setScreen] = useState<Screen>(() => (credentialStore.get() ? { kind: "boot" } : { kind: "pairing" }));
  const [conn, setConn] = useState<ConnectionState>("closed");
  const [toast, setToast] = useState<Toast | null>(null);
  /** Home's Back at the root asks «Выйти из Cineko?» — never a silent exit / reload. */
  const [exitAsk, setExitAsk] = useState(false);
  // Startup intro: once per app start, in the design this TV last showed.
  const [intro, setIntro] = useState(() => (shouldShowIntro(introEnv()) ? themeCache.design() : null));
  const endIntro = useCallback(() => setIntro(null), []);
  // The intro's scene is its own chunk: fetch it with the intro shell.
  useEffect(() => {
    if (intro) preloadIntroScene(intro);
  }, [intro]);
  // Screen stack inside the signed-in area (Home → Details → …). Kept here,
  // outside the "home" screen, so switching profiles and coming back keeps it.
  const [stack, setStack] = useState<StackEntry[]>(initialStack);
  // What the Details on top reported about its title (for device.state).
  const [details, setDetails] = useState<{ key: number; info: DetailsInfo } | null>(null);
  const screenRef = useRef(screen);
  const stackRef = useRef(stack);
  const detailsRef = useRef(details);
  const pendingRef = useRef<Pending | null>(null);
  const { t, locale } = useI18n();
  // «Язык» is one of this TV's own options (a phone may change it).
  useTvOwnLanguage();
  const flow = useFlow();
  const liveSession = useLive();
  const videoOn = useVideoSession();
  const tRef = useRef(t);
  const localeRef = useRef(locale);
  useEffect(() => {
    screenRef.current = screen;
    stackRef.current = stack;
    detailsRef.current = details;
    tRef.current = t;
    localeRef.current = locale;
  }, [screen, stack, details, t, locale]);

  // Works out the next screen from the server (requires a stored credential).
  const load = useCallback(async (): Promise<Screen> => {
    try {
      const [device, profiles] = await Promise.all([
        unwrap(api.GET("/devices/me")),
        unwrap(api.GET("/profiles")).then((r) => r.items),
      ]);
      realtime.start();
      // This TV's own options (screensaver, sounds, language…): server copy, seeded from here once.
      void tvOwn.sync();
      // This TV's playback profile: report what it detects (quietly, later on).
      setTimeout(() => void devicePrefs.sync(), 3000);
      // Background speed test (first one ~25 s later; never while playing).
      startSpeedtest();
      // Health reports («Состояние»: memory, smoothness), ~2 min later, then every 10 min.
      startHealth();
      return landing(device, profiles);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        credentialStore.clear();
        return { kind: "pairing" };
      }
      // Keep the credential: the server or network is just unreachable.
      return { kind: "offline" };
    }
  }, []);

  const boot = useCallback(() => {
    setScreen({ kind: "boot" });
    void load().then(setScreen);
  }, [load]);

  useEffect(() => {
    if (credentialStore.get()) void load().then(setScreen);
  }, [load]);

  // Credential revoked or unknown → back to pairing.
  useEffect(
    () =>
      onUnauthorized(() => {
        realtime.stop();
        credentialStore.clear();
        setScreen({ kind: "pairing" });
      }),
    [],
  );

  // Retry from the offline screen automatically.
  useEffect(() => {
    if (screen.kind !== "offline") return;
    const id = setTimeout(() => void load().then(setScreen), 5000);
    return () => clearTimeout(id);
  }, [screen.kind, load]);

  useEffect(() => realtime.onState(setConn), []);

  // The signed-in profile drives settings, `me` annotations and progress.
  const profileId = screen.kind === "home" ? screen.profile.id : null;
  if (activeProfile.get() !== profileId) activeProfile.prime(profileId);
  useEffect(() => activeProfile.set(profileId), [profileId]);
  const settings = useLoadedSettings();
  const known = !!profileId && !!settings;
  const theme = known ? settings.theme : themeCache.get();
  // «Сюрприз»: today's / this week's pick from the favourites (rolls over at midnight while running).
  const shown = useEffectiveDesign(known ? settings : null, profileId);
  const design = known && shown ? shown : themeCache.design();
  useEffect(() => {
    if (known) themeCache.setDesign(design, settings, profileId);
  }, [known, design, settings, profileId]);
  useEffect(() => {
    if (known) themeCache.set(theme);
    // A design switch waits for the design's own chunk (CSS + drawings), so it never shows half-styled.
    let live = true;
    let undo: (() => void) | undefined;
    const apply = () => {
      if (!live) return;
      applyDesign(design);
      // Light colours exist for «Кинозал» only; the other designs are dark.
      undo = applyTheme(design === "kinozal" ? theme : "dark");
    };
    if (getLook(design)) apply();
    else void loadLook(design).catch(() => undefined).then(apply);
    return () => {
      live = false;
      undo?.();
    };
  }, [theme, design, known]);

  // Admin messages: unread ones once at start (and after pairing).
  const signedIn = screen.kind === "home" || screen.kind === "profiles";
  useEffect(() => {
    if (!signedIn) return;
    void unwrap(api.GET("/messages"))
      .then((r) => messageQueue.addAll(r.items.filter((m) => !m.read_at)))
      .catch(() => undefined);
  }, [signedIn]);

  // What the TV shows, as reported to controllers. The TV is the authority.
  const currentState = useCallback(() => {
    const s = screenRef.current;
    const top = stackRef.current[stackRef.current.length - 1]!;
    const d = detailsRef.current;
    const f = player.flow;
    const inPlayer = s.kind === "home" && f.phase !== "idle" && flowScreen(f) === "player" ? f : null;
    const ls = s.kind === "home" ? live.get() : null;
    const vs = s.kind === "home" ? videoSession.get() : null;
    return buildDeviceState({
      screen: s.kind === "home" ? "catalog" : s.kind,
      route: top.route,
      profile: s.kind === "home" ? { id: s.profile.id, name: s.profile.name } : null,
      details: d && d.key === top.key ? d.info : null,
      playback: s.kind === "home" ? player.playback() : null,
      player: inPlayer
        ? {
            media_id: inPlayer.ctx.media_id,
            kind: inPlayer.ctx.kind,
            title: inPlayer.ctx.title,
            poster_path: inPlayer.ctx.poster_path,
            season_number: inPlayer.ctx.season,
          }
        : null,
      playerError: inPlayer ? player.failure() : null,
      players: { available: currentPlayers(), default: defaultPlayerStore.get() },
      live: ls
        ? { channel_id: ls.channel.id, name: ls.channel.name, number: ls.channel.number, programme: programmeTitle(ls.channel), paused: live.controls()?.paused() ?? false }
        : null,
      video: vs ? videoPlaybackState(vs.video, videoSession.controls()?.info() ?? null) : null,
      audio: { ...tvVolume.level(), source: tvVolume.source(), system: tvVolume.status() },
    });
  }, []);

  // Health reports name the screen the TV is on.
  useEffect(() => setHealthScreen(() => currentState().screen), [currentState]);

  const lastSent = useRef("");
  const sendState = useCallback(
    (always: boolean) => {
      if (realtime.state !== "open") return;
      const st = currentState();
      const k = stateKey(st);
      if (!always && k === lastSent.current) return;
      lastSent.current = k;
      realtime.send({ type: "device.state", payload: st });
    },
    [currentState],
  );

  // On every change (debounced, so a burst of changes sends one state).
  useEffect(() => {
    if (conn !== "open") return;
    const id = setTimeout(() => sendState(false), 150);
    return () => clearTimeout(id);
  }, [conn, screen, stack, details, flow, liveSession, videoOn, sendState]);

  // Playback events (play/pause/seek/buffering/tracks) are reported at once;
  // while playing, the position every few seconds (identical states skipped).
  useEffect(() => player.subscribe((k) => k === "playback" && sendState(false)), [sendState]);
  // «Видео»: play/pause/seek/buffering/quality from the YouTube player, at once.
  useEffect(() => videoSession.onChange(() => sendState(false)), [sendState]);
  // Live TV paused / resumed; the volume changed (by a phone or the TV's own buttons).
  useEffect(() => live.onChange(() => sendState(false)), [sendState]);
  useEffect(() => tvVolume.subscribe(() => sendState(false)), [sendState]);
  useEffect(() => {
    if (conn !== "open") return;
    const id = setInterval(() => sendState(false), STATE_EVERY);
    return () => clearInterval(id);
  }, [conn, sendState]);

  // Leaving the signed-in area stops playback.
  useEffect(() => {
    if (screen.kind !== "home" && player.flow.phase !== "idle") player.close();
    if (screen.kind !== "home") live.close();
    if (screen.kind !== "home") videoSession.close();
  }, [screen.kind]);

  const onDetailsInfo = useCallback((key: number, info: DetailsInfo) => setDetails({ key, info }), []);

  const openedToast = useCallback((sender: Sender, title?: string | null) => {
    const tt = tRef.current;
    setToast({ label: sender ? tt("remote.opened_by", { name: sender }) : tt("remote.tv.opened"), text: title ?? undefined, ms: 4500 });
  }, []);

  /**
   * Opens Details on top of `base` (Back returns to where the user was) and
   * returns the new stack. Uses the cached title, if any, for the state.
   */
  const applyOpen = useCallback((base: StackEntry[], req: OpenRequest, sender: Sender) => {
    const next = openDetails(base, { id: req.media_id, season: req.season_number, episode: req.episode_number });
    const top = next[next.length - 1]!;
    const cached = queryClient.getQueryData<MediaDetail>(["media", req.media_id, catalogLang(localeRef.current)]);
    const info: DetailsInfo | null = cached
      ? {
          title: cached.title,
          poster_path: cached.poster_path ?? null,
          kind: cached.kind,
          season_number: cached.kind === "series" ? pickSeason(cached.seasons, req.season_number) : null,
        }
      : null;
    stackRef.current = next;
    detailsRef.current = info ? { key: top.key, info } : null;
    setStack(next);
    setDetails(detailsRef.current);
    openedToast(sender, cached?.title);
    return next;
  }, [openedToast]);

  /** The Details entry for a title (on top of the stack), opening it if needed. */
  const detailsEntry = useCallback(
    (mediaId: string, sender: Sender): StackEntry => {
      const cur = stackRef.current;
      const top = cur[cur.length - 1]!;
      if (top.route.name === "details" && top.route.id === mediaId) return top;
      rememberFocus(top.mem);
      const next = applyOpen(cur, { media_id: mediaId }, sender);
      return next[next.length - 1]!;
    },
    [applyOpen],
  );

  /**
   * media.play: Details of the title goes on the stack (the player exits
   * there), then playback starts with the requested / default player.
   */
  const startRemotePlay = useCallback(
    (req: PlayRequest, sender: Sender, profile: Profile): "unsupported" | null => {
      const choice = resolvePlayer(req.player, defaultPlayerStore.get(), currentPlayers());
      if ("error" in choice) return "unsupported";
      const entry = detailsEntry(req.media_id, sender);
      const base = { profile_id: profile.id, lang: catalogLang(localeRef.current) };
      player.playRemote(req, base, entry.mem, "player" in choice ? { player: choice.player } : undefined);
      return null;
    },
    [detailsEntry],
  );

  /** Play from Details: the release picker, or the best release right away. */
  const startLocalPlay = useCallback((entry: StackEntry, media: MediaDetail, episode: Episode | null, how: PlayHow, startAt = 0) => {
    const s = screenRef.current;
    if (s.kind !== "home") return;
    const ctx: PlayContext = {
      media_id: media.id,
      kind: media.kind,
      title: media.title,
      poster_path: media.poster_path ?? null,
      backdrop_path: media.backdrop_path ?? null,
      season: episode?.season_number ?? null,
      episode: episode?.episode_number ?? null,
      episode_id: episode?.id ?? null,
      episode_name: episode?.name ?? null,
      profile_id: s.profile.id,
      lang: catalogLang(localeRef.current),
      player: null,
      app: null,
      start_at: startAt,
    };
    if (how === "best") player.playBest(ctx, startAt, entry.mem);
    else if (how === "pick") player.pick(ctx, entry.mem);
    else if ("source_id" in how) player.playSource(ctx, how.source_id, startAt, entry.mem);
    else player.playChosen(ctx, how, startAt, entry.mem);
  }, []);

  /** Continue watching: straight to playback (best release) at the saved position. */
  const startContinue = useCallback((entry: StackEntry, item: ContinueItem) => {
    const s = screenRef.current;
    if (s.kind !== "home") return;
    const m = item.media;
    const p = item.progress && !item.progress.completed ? item.progress : null;
    const n = item.next_up;
    const ep = p?.episode_id
      ? { id: p.episode_id, season: p.season_number, episode: p.episode_number, name: null as string | null }
      : n
        ? { id: n.episode_id, season: n.season_number, episode: n.episode_number, name: n.name }
        : null;
    const startAt = p ? p.position_seconds : 0;
    const ctx: PlayContext = {
      media_id: m.id,
      kind: m.kind,
      title: m.title,
      poster_path: m.poster_path ?? null,
      backdrop_path: m.backdrop_path ?? null,
      season: ep?.season ?? null,
      episode: ep?.episode ?? null,
      episode_id: ep?.id ?? null,
      episode_name: ep?.name ?? null,
      profile_id: s.profile.id,
      lang: catalogLang(localeRef.current),
      player: null,
      app: null,
      start_at: startAt,
    };
    rememberFocus(entry.mem);
    // The source it was last watched with (same voice-over / quality).
    if (p?.source_id && startAt > 0) player.playSource(ctx, p.source_id, startAt, entry.mem);
    else player.playBest(ctx, startAt, entry.mem);
  }, []);

  /** Live TV: play a channel; Up/Down switch through `list`. */
  const startLive = useCallback((channel: IptvChannel, list: IptvChannel[]) => live.open(channel, list), []);

  /** «Видео»: play a YouTube video (start null = its resume position). */
  const startVideo = useCallback((video: VideoItem, start: number | null) => {
    live.close();
    videoSession.open(video, { start });
  }, []);

  /** Runs a playback control command for the processor. */
  const control = useCallback(
    (cmd: PlayerCommand) => {
      const f = player.flow;
      // «Видео»: pause / resume / seek / stop through the mounted player.
      const vc = videoSession.active() && screenRef.current.kind === "home" ? videoSession.controls() : null;
      if (f.phase === "idle" && videoSession.active() && screenRef.current.kind === "home") {
        const r = videoControl(cmd, vc, () => videoSession.close());
        return r === true ? currentState() : r;
      }
      // Live TV: pause / resume / stop (no seek, tracks or sources on a channel).
      if (f.phase === "idle" && live.active() && screenRef.current.kind === "home") {
        const r = liveControl(cmd.type, live.controls(), () => live.close());
        return r === true ? currentState() : r;
      }
      if (f.phase === "idle" || screenRef.current.kind !== "home") return "failed" as const;
      const handedOff = player.handedOff();
      const ok = () => currentState();
      switch (cmd.type) {
        case "stop":
          if (handedOff) return "unsupported" as const;
          player.close();
          return ok();
        case "pause":
          if (handedOff) return "unsupported" as const;
          return player.pause() ? ok() : ("failed" as const);
        case "resume":
          if (handedOff) return "unsupported" as const;
          return player.resume() ? ok() : ("failed" as const);
        case "seek":
          if (handedOff) return "unsupported" as const;
          return player.seekTo(cmd.position_seconds) ? ok() : ("failed" as const);
        case "next_episode":
          if (f.ctx.kind !== "series") return "failed" as const;
          return player.nextEpisode() ? ok() : ("failed" as const);
        case "select_source":
          return player.selectSource(cmd.source_id) ? ok() : ("failed" as const);
        case "set_audio": {
          if (handedOff) return "unsupported" as const;
          const r = player.setAudio(cmd.track_id);
          return r === true ? ok() : r;
        }
        case "set_subtitles": {
          if (handedOff) return "unsupported" as const;
          const r = player.setSubtitles(cmd.track_id);
          return r === true ? ok() : r;
        }
      }
    },
    [currentState],
  );

  /** Runs a media.open queued on the profile picker (if still fresh). */
  const takePending = useCallback(() => {
    const p = pendingRef.current;
    pendingRef.current = null;
    return p && Date.now() - p.at < PENDING_TTL ? p : null;
  }, []);

  // Executes commands from phones and acknowledges every one of them.
  // (The callbacks used here are stable, so this runs once per app start.)
  useEffect(() => {
    const processor = new CommandProcessor({
      screen: () => currentState().screen,
      playback: () => (screenRef.current.kind === "home" && player.busy() ? player.playback() : null),
      state: currentState,
      open: (req, sender) => {
        // Forced over playback (or over the picker): the player closes first.
        if (player.flow.phase !== "idle") player.close();
        live.close();
        videoSession.close();
        const cur = stackRef.current;
        // Back must restore the exact focus (a card, or the side menu).
        rememberFocus(cur[cur.length - 1]!.mem);
        applyOpen(cur, req, sender);
        return currentState();
      },
      play: (req, sender) => {
        const s = screenRef.current;
        if (s.kind !== "home") return "failed";
        live.close();
        videoSession.close();
        const err = startRemotePlay(req, sender, s.profile);
        return err ?? currentState();
      },
      queuePlay: (req, sender) => {
        pendingRef.current = { req: { media_id: req.media_id }, play: req, sender, at: Date.now() };
        const tt = tRef.current;
        setToast({ label: sender ? tt("remote.tv.queued_by", { name: sender }) : tt("remote.tv.queued"), ms: 8000 });
      },
      control,
      queue: (req, sender) => {
        pendingRef.current = { req, sender, at: Date.now() };
        const tt = tRef.current;
        setToast({ label: sender ? tt("remote.tv.queued_by", { name: sender }) : tt("remote.tv.queued"), ms: 8000 });
      },
      playLive: (req, sender) => {
        if (screenRef.current.kind !== "home") return "failed";
        if (player.flow.phase !== "idle") player.close();
        videoSession.close();
        void findChannel(req.channel_id)
          .then((r) => {
            if (!r) return setToast({ label: tRef.current("iptv.tv.channel_gone"), ms: 5000 });
            live.open(r.channel, r.list);
            openedToast(sender, r.channel.name);
          })
          .catch(() => setToast({ label: tRef.current("iptv.play_failed"), ms: 5000 }));
        return currentState();
      },
      // video.play: the TV keeps its own profile; the phone's position (if any) is where it starts.
      playVideo: (req, sender) => {
        if (screenRef.current.kind !== "home") return "failed";
        // The same video with a quality: switch in place (the phone's quality select).
        const inPlace = player.flow.phase === "idle" ? qualityInPlace(req, videoSession.get(), videoSession.controls()) : null;
        if (inPlace !== null) return inPlace ? currentState() : "failed";
        if (player.flow.phase !== "idle") player.close();
        live.close();
        videoSession.open({ id: req.video_id }, { start: req.position_seconds ?? null, quality: req.quality ?? null });
        openedToast(sender, null);
        return currentState();
      },
      // playback.set_volume: on any screen; nothing playing = stored for the next playback.
      volume: (change) => {
        tvVolume.change(change);
        return currentState();
      },
      busy: () => screenRef.current.kind === "home" && videoSession.active(),
      // Still on the loading screen: a new media.play replaces it without the «interrupt?» question.
      // Stuck rebuffering mid-film counts too: a new title from a phone takes over at once.
      loading: () => screenRef.current.kind === "home" && !videoSession.active() && (player.loading() || player.rebuffering() !== null),
      showMessage: (text, sender) => {
        const tt = tRef.current;
        setToast({ label: sender ? tt("remote.tv.message_from", { name: sender }) : tt("tv.message_from"), text, ms: 6000 });
      },
    });
    return realtime.on((env: Envelope) => {
      // (Re)connected: the server and controllers learn the state right away.
      if (env.type === "hello") {
        // Changed from a phone while this TV was offline: pick it up.
        void tvOwn.sync();
        return sendState(true);
      }
      // Settings changed from a phone / computer (an event: never acked):
      // this TV's own options and, with profile_id, that profile's look here.
      if (env.type === "settings.changed") {
        void tvOwn.sync();
        const pid = (env.payload as { profile_id?: unknown } | undefined)?.profile_id;
        if (typeof pid === "string") void queryClient.invalidateQueries({ queryKey: settingsKey(pid) });
        return;
      }
      // Admin message (an event: never acked).
      if (env.type === "message") {
        void queryClient.invalidateQueries({ queryKey: ["inbox"] });
        return void messageQueue.add(parseMessageEvent(env.payload));
      }
      // «Советуют близкие»: a toast and a fresh inbox (an event: never acked).
      if (env.type === "recommendation") {
        void queryClient.invalidateQueries({ queryKey: ["reco-inbox"] });
        const r = env.payload as { from?: { name?: string }; media?: { title?: string } } | undefined;
        if (r?.from?.name && r.media?.title) setToast({ label: tRef.current("reco.toast", { name: r.from.name, title: r.media.title }), ms: 6000 });
        return;
      }
      // «Для вас» rebuilt / new collections (an event: never acked).
      if (env.type === "foryou.updated") return invalidateForYou();
      // «Спросить ИИ» asked from a phone for this TV: show the answer (an event: never acked).
      if (env.type === "foryou.ask") {
        const r = parseAskEvent(env.payload);
        if (!r) return;
        askInbox.push(r);
        void queryClient.invalidateQueries({ queryKey: ["foryou", "asks"] });
        if (screenRef.current.kind === "home" && player.flow.phase === "idle") setStack((st) => openSection(st, { name: "ask" }));
        return;
      }
      const ack = processor.handle(env);
      if (ack && env.id) realtime.send({ id: env.id, type: "ack", payload: ack });
    });
  }, [currentState, applyOpen, sendState, startRemotePlay, control, openedToast]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(id);
  }, [toast]);

  // Remote Back key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isBackKey(e)) return;
      e.preventDefault();
      const s = screenRef.current;
      // The player handles its own keys (preparing/playing); the rest of the
      // flow (picker, chooser, errors, hand-off) steps back here.
      const f = player.flow;
      // Live TV handles its own keys (capture phase).
      if (s.kind === "home" && live.active()) return;
      // So does the «Видео» player.
      if (s.kind === "home" && videoSession.active()) return;
      if (s.kind === "home" && f.phase !== "idle") {
        if (f.phase === "playing" && player.handedOff()) return player.close();
        if (f.phase === "picker" || f.phase === "choose" || f.phase === "failed") return player.back();
        return;
      }
      if (s.kind === "token") return setScreen({ kind: "pairing" });
      // Deep in a page, Back first jumps to the top / the menu (a second Back leaves).
      if (s.kind === "home" && runBackFirst()) return;
      if (s.kind === "home" && stackRef.current.length > 1) return setStack(pop);
      if (s.kind === "profiles" && s.current) {
        const p = takePending();
        const profile = s.current;
        if (p) applyOpen(stackRef.current, p.req, p.sender);
        setScreen({ kind: "home", device: s.device, profiles: s.profiles, profile });
        if (p?.play) startRemotePlay(p.play, p.sender, profile);
        return;
      }
      // The root: ask (the confirm owns the keys; «Остаться» is focused, so a
      // double Back stays). Inside MSX a silent history.back()/close left
      // Cineko and MSX re-opened it.
      setExitAsk(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [takePending, applyOpen, startRemotePlay]);


  const paired = (credential: string) => {
    credentialStore.set(credential);
    setStack(initialStack());
    boot();
  };

  let body: React.ReactNode;
  switch (screen.kind) {
    case "boot":
      body = (
        <Centered>
          <Logo className="mb-10 text-7xl" />
          <Spinner size={56} />
        </Centered>
      );
      break;
    case "offline":
      body = (
        <Centered>
          <Logo className="mb-10 text-7xl" />
          <p className="mb-10 text-4xl text-muted">{design === "constructivism" ? CV_OFFLINE : t("tv.offline")}</p>
          <FocusButton focusKey="offline-retry" autoFocus onPress={boot} className="rounded-2xl bg-accent px-10 py-5 text-3xl font-semibold text-on-accent">
            {t("common.retry")}
          </FocusButton>
        </Centered>
      );
      break;
    case "pairing":
      body = <PairingScreen onPaired={paired} onManual={() => setScreen({ kind: "token" })} />;
      break;
    case "token":
      body = <TokenScreen onPaired={paired} onBack={() => setScreen({ kind: "pairing" })} />;
      break;
    case "profiles":
      body = (
        <ProfilesScreen
          profiles={screen.profiles}
          initialProfileId={screen.current?.id ?? screen.device.default_profile_id}
          onProfiles={(profiles) => setScreen({ ...screen, profiles })}
          onSelect={(profile) => {
            profileStore.set(profile.id);
            // Another profile starts at Home; the same one returns where it was.
            let next = profile.id !== screen.current?.id ? initialStack() : stackRef.current;
            const p = takePending();
            if (p) next = applyOpen(next, p.req, p.sender);
            stackRef.current = next;
            setStack(next);
            const home: Screen = { kind: "home", device: screen.device, profiles: screen.profiles, profile };
            screenRef.current = home;
            setScreen(home);
            if (p?.play) startRemotePlay(p.play, p.sender, profile);
          }}
        />
      );
      break;
    case "home":
      body =
        flow.phase !== "idle" || liveSession || videoOn ? (
          // The players load lazily (prefetched after startup, lazy.tsx).
          <Suspense fallback={<PlayerWait />}>{flow.phase !== "idle" ? <PlayerLayer /> : liveSession ? <LivePlayer /> : <VideoPlayer />}</Suspense>
        ) : (
        <CatalogShell
          profile={screen.profile}
          stack={stack}
          setStack={setStack}
          onBack={() => setStack(pop)}
          onDetailsInfo={onDetailsInfo}
          onPlay={startLocalPlay}
          onContinue={startContinue}
          onLive={startLive}
          onVideo={startVideo}
          onSwitchProfile={() =>
            setScreen({ kind: "profiles", device: screen.device, profiles: screen.profiles, current: screen.profile })
          }
        />
      );
      break;
  }

  const showConn = screen.kind === "home" || screen.kind === "profiles";
  const device = screen.kind === "home" || screen.kind === "profiles" ? screen.device : null;
  return (
    <DesignProvider value={design}>
    <DeviceProvider value={device}>
    <div className="relative h-full w-full">
      {/* Pairing / profile pick: the skin's background behind the screen (the catalog draws its own). */}
      {screen.kind === "home" ? body : (
        <>
          <SkinBackground />
          <div className="relative h-full w-full">{body}</div>
        </>
      )}
      {showConn && conn !== "open" && (
        <div className="absolute right-12 top-10 rounded-full bg-surface-2 px-6 py-3 text-2xl text-muted">
          {navigator.onLine ? t("tv.reconnecting") : design === "constructivism" ? CV_OFFLINE : t("tv.offline")}
        </div>
      )}
      {toast && (
        <div
          data-testid="tv-toast"
          className="absolute bottom-16 left-1/2 z-20 max-w-[1200px] -translate-x-1/2 rounded-3xl bg-surface-2 px-12 py-8 text-4xl shadow-2xl"
        >
          <span className="text-accent">
            {toast.label}
            {toast.text ? ":" : ""}
          </span>
          {toast.text && <span className="ml-4">{toast.text}</span>}
        </div>
      )}
      <VolumeOsd />
      {screen.kind === "home" && <RateLayer enabled={flow.phase === "idle" && !liveSession && !videoOn} />}
      {screen.kind === "home" && <MessageLayer playing={screen.kind === "home" && player.busy() && !player.handedOff()} onPause={pauseForMessage} />}
      {exitAsk && (
        <ActionMenu
          title={t("tv.exit_confirm")}
          testId="exit-confirm"
          actions={[
            { key: "stay", label: t("tv.exit_stay"), primary: true, onPress: () => setExitAsk(false) },
            { key: "exit", label: t("tv.exit_leave"), onPress: () => exitApp() },
          ]}
          onCancel={() => setExitAsk(false)}
        />
      )}
      <PillLayer onRed={() => setIntro("matrix")} />
      <PausedSaver />
      {intro && (
        <Suspense fallback={<div data-testid="startup-intro-wait" className="absolute left-0 top-0 h-[1080px] w-[1920px]" style={{ background: DESIGN_SWATCH[intro].bg, zIndex: 80 }} />}>
          <StartupIntro design={intro} onDone={endIntro} />
        </Suspense>
      )}
    </div>
    </DeviceProvider>
    </DesignProvider>
  );
}
