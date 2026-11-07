// Full-screen live TV player. Up/Down and Channel▲▼ switch channels, digits
// jump to a number, an OSD shows the channel and its programme on every
// switch, OK opens a mini channel list, Back closes it / leaves. Live
// streams have no seek bar, duration or progress reports: only a "watched
// channel" event after a few seconds.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import type { IptvChannel } from "@martytv/contracts";
import {
  apiErrorCode,
  hasMediaSource,
  isAndroid,
  liveCodecProblem,
  liveEngines,
  liveFailureFromCode,
  mseTypeSupported,
  type LiveEngine,
  type LiveFailure,
} from "@martytv/media-types";
import { reportError, Spinner, useI18n } from "@martytv/ui";
import { ChannelLogo, EpgBar } from "./ChannelLogo";
import { useDesign, type Design } from "../design/context";
import { playerKey, registerMediaKeys } from "../player/keys";
import { tvVolume } from "../player/volume";
import { attachHlsJs, type HlsHandle } from "../player/stream";
import { attachMpegts } from "../player/mpegts";
import { claimKeys } from "../remote/keyOwner";
import { ProgramPanel, useChannelProgram } from "./ProgramPanel";
import { channelByNumber, dayStatuses, digitKey, epgProgress, hhmm, NumberInput, stepChannel } from "./logic";
import { live, useLive } from "./live";
import { createLiveSource, reportWatched, useIptvChannels } from "./queries";

/** OSD visible after a switch / info key. */
const OSD_MS = 5000;
/** Holding ▲▼ flips channels: the stream starts only once the user stops. */
const SWITCH_DEBOUNCE = 350;
/** Playing this long counts as watching the channel. */
const WATCHED_AFTER = 5000;
/** Mini list rows. */
const ROW_H = 104;
const LIST_ROWS = 9;

type Phase = "loading" | "playing" | "error";
type Failure = { kind: LiveFailure; codec?: string };

export function LivePlayer() {
  const session = useLive();
  if (!session) return null;
  return <LiveInner />;
}

function LiveInner() {
  const session = useLive()!;
  const { t } = useI18n();
  const design = useDesign();
  const fresh = useIptvChannels();
  // The list's now/next refresh every minute; fall back to the session's copy.
  const byId = useMemo(() => new Map((fresh.data?.items ?? []).map((c) => [c.id, c] as const)), [fresh.data]);
  const pick = useCallback((c: IptvChannel) => byId.get(c.id) ?? c, [byId]);
  const channel = pick(session.channel);
  const list = session.list;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [osd, setOsd] = useState(true);
  const [digits, setDigits] = useState("");
  const [listIdx, setListIdx] = useState<number | null>(null);
  /** «Программа на сегодня» panel: closed (null), open at the current show (-1) or at a row. */
  const [prog, setProg] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const osdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showOsd = useCallback(() => {
    setOsd(true);
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), OSD_MS);
  }, []);
  useEffect(() => () => clearTimeout(osdTimer.current), []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Every switch shows the OSD (adjusted during render), hidden again after OSD_MS.
  const [seenSeq, setSeenSeq] = useState(session.seq);
  if (seenSeq !== session.seq) {
    setSeenSeq(session.seq);
    setOsd(true);
  }
  useEffect(() => {
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), OSD_MS);
  }, [session.seq]);

  // ---- the stream: a fresh source per switch (debounced). The engines of
  // liveEngines() are tried in order (native → hls.js / mpegts.js); when all
  // fail the source is POSTed once more (the server tries the channel's
  // mirrors and answers with a cause), then the error stays — no retry loop.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const id = session.channel.id;
    let cancelled = false;
    let handle: HlsHandle | null = null;
    let reposted = false;
    let watched: ReturnType<typeof setTimeout> | undefined;
    let ctx: { format?: string | null; video?: string | null; audio?: string | null; engine?: LiveEngine } = {};
    setPhase("loading");
    setFailure(null);

    const reset = () => {
      handle?.destroy();
      handle = null;
      v.removeAttribute("src");
      try {
        v.load();
      } catch {
        // ignore
      }
    };
    const fail = (f: Failure) => {
      if (cancelled) return;
      clearTimeout(watched);
      reset();
      setFailure(f);
      setPhase("error");
      // geo / offline / timeout come from the API (its middleware reports them).
      if (f.kind === "codec" || f.kind === "format" || f.kind === "broken") {
        reportError("player", `live: ${f.kind}${f.codec ? ` (${f.codec})` : ""}`, { component: "live", extra: { ...ctx, channel: session.channel.name } });
      }
    };
    let engines: LiveEngine[] = [];
    let url = "";
    const next = () => {
      if (cancelled) return;
      clearTimeout(watched);
      watched = undefined;
      reset();
      setPhase("loading");
      const e = engines.shift();
      if (e) return void play(e);
      if (!reposted) {
        reposted = true;
        return void start();
      }
      fail({ kind: "broken" });
    };
    const play = async (e: LiveEngine) => {
      ctx = { ...ctx, engine: e };
      if (e === "native") {
        v.src = url;
        void v.play().catch(() => undefined);
        return;
      }
      const h = await (e === "mpegts" ? attachMpegts(v, url, next) : attachHlsJs(v, url, next)).catch(() => null);
      if (cancelled) return h?.destroy();
      if (!h) return next();
      handle = h;
      void v.play().catch(() => undefined);
    };
    const start = async () => {
      let src;
      try {
        src = await createLiveSource(id);
      } catch (e) {
        return fail({ kind: liveFailureFromCode(apiErrorCode(e)) });
      }
      if (cancelled) return;
      ctx = { format: src.format, video: src.video_codec, audio: src.audio_codec };
      url = src.stream_url ?? "";
      engines = liveEngines(src.format, v, hasMediaSource(), isAndroid());
      // Only MSE engines (no native player): the browser must decode the codecs.
      const codec = engines.includes("native") ? null : liveCodecProblem(src, mseTypeSupported());
      if (!url || engines.length === 0 || codec) return fail(codec ? { kind: "codec", codec } : { kind: "format" });
      next();
    };
    const onPlaying = () => {
      if (cancelled) return;
      setPhase("playing");
      if (watched === undefined) watched = setTimeout(() => reportWatched(id), WATCHED_AFTER);
    };
    const onWaiting = () => !cancelled && setPhase((p) => (p === "error" ? p : "loading"));
    // Native playback errors (hls.js / mpegts.js report their own).
    const onError = () => {
      if (!handle) next();
    };
    v.addEventListener("playing", onPlaying);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("error", onError);
    const debounce = setTimeout(() => void start(), SWITCH_DEBOUNCE);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearTimeout(watched);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("error", onError);
      reset();
    };
  }, [session.seq, session.channel.id, session.channel.name]);

  // ---- the phone remote: pause / resume, the TV's saved volume.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const unbind = tvVolume.bind(v);
    const changed = () => live.changed();
    v.addEventListener("play", changed);
    v.addEventListener("pause", changed);
    live.setControls({
      pause: () => {
        v.pause();
        showOsd();
        return true;
      },
      resume: () => {
        // A long pause fell behind the broadcast: back to the live edge.
        const s = v.seekable;
        if (s && s.length > 0 && s.end(s.length - 1) - v.currentTime > 30) v.currentTime = Math.max(0, s.end(s.length - 1) - 3);
        void v.play().catch(() => undefined);
        showOsd();
        return true;
      },
      paused: () => v.paused,
    });
    return () => {
      unbind();
      v.removeEventListener("play", changed);
      v.removeEventListener("pause", changed);
      live.setControls(null);
    };
  }, [showOsd]);

  // ---- keys
  const go = useCallback((c: IptvChannel | null) => {
    if (c) live.switchTo(c);
  }, []);
  const numberInput = useMemo(
    () =>
      new NumberInput(
        (n) => go(channelByNumber(live.get()?.list ?? [], n)),
        (d) => setDigits(d),
      ),
    [go],
  );
  useEffect(() => () => numberInput.dispose(), [numberInput]);

  const program = useChannelProgram(channel, prog !== null);
  const progFocus = dayStatuses(program.items, now).focus;
  const st = useRef({ listIdx, list, channelId: channel.id, prog, progFocus, progCount: program.items.length });
  useEffect(() => {
    st.current = { listIdx, list, channelId: channel.id, prog, progFocus, progCount: program.items.length };
  });
  useEffect(() => {
    pauseNav();
    const claim = claimKeys();
    const unregister = registerMediaKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!claim.top) return;
      const d = digitKey(e);
      const k = playerKey(e);
      if (d === null && !k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const { listIdx, list, channelId, prog: pg, progFocus: pf, progCount } = st.current;
      if (d !== null) {
        numberInput.push(d);
        showOsd();
        return;
      }
      if (pg !== null) {
        const at = pg < 0 ? pf : pg;
        if (k === "up") setProg(Math.max(0, at - 1));
        else if (k === "down") setProg(Math.min(Math.max(0, progCount - 1), at + 1));
        else if (k === "back" || k === "left" || k === "right" || k === "guide" || k === "ok") setProg(null);
        return;
      }
      if (listIdx !== null) {
        const last = list.length - 1;
        if (k === "up") setListIdx(Math.max(0, listIdx - 1));
        else if (k === "down") setListIdx(Math.min(last, listIdx + 1));
        else if (k === "chup") setListIdx(Math.max(0, listIdx - LIST_ROWS));
        else if (k === "chdown") setListIdx(Math.min(last, listIdx + LIST_ROWS));
        else if (k === "ok" && !e.repeat) {
          const c = list[listIdx];
          setListIdx(null);
          if (c && c.id !== channelId) go(c);
          else showOsd();
        } else if (k === "back" || k === "left") setListIdx(null);
        return;
      }
      switch (k) {
        case "up":
        case "chup":
        case "next":
          return go(stepChannel(list, channelId, 1));
        case "down":
        case "chdown":
        case "prev":
          return go(stepChannel(list, channelId, -1));
        case "ok":
          if (e.repeat) return;
          if (numberInput.commit()) return;
          setOsd(false);
          return setListIdx(Math.max(0, list.findIndex((c) => c.id === channelId)));
        case "right":
        case "guide":
          setOsd(false);
          return setProg(-1);
        case "left":
        case "play":
        case "playpause":
          return showOsd();
        case "back":
          if (numberInput.cancel()) return;
          return live.close();
        case "stop":
          return live.close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      claim.release();
      unregister();
      resumeNav();
    };
  }, [go, numberInput, showOsd]);

  return (
    <div data-testid="live-player" data-channel-id={channel.id} data-phase={phase} className="absolute left-0 top-0 h-[1080px] w-[1920px] overflow-hidden bg-black">
      <video ref={videoRef} className="absolute left-0 top-0 h-full w-full" style={{ objectFit: "contain" }} preload="auto" playsInline autoPlay />
      {phase === "loading" && (
        <div className="absolute left-0 top-0 flex h-full w-full items-center justify-center">
          <Spinner size={88} />
        </div>
      )}
      {phase === "error" && (
        <div data-testid="live-error" className="absolute left-0 top-0 flex h-full w-full items-center justify-center">
          <div className="tv-key-hint max-w-[1100px] rounded-card px-14 py-10 text-center">
            <p className="text-[40px] font-bold text-text">{channel.name}</p>
            <p data-testid="live-error-cause" data-cause={failure?.kind} className="mt-4 text-[30px] text-muted">
              {t(`iptvplay.err.${failure?.kind ?? "broken"}`, { codec: failure?.codec ?? "" })}
            </p>
            <p className="mt-6 text-[24px] text-muted">{t("iptv.tv.error_hint")}</p>
          </div>
        </div>
      )}
      {digits && <Digits design={design} digits={digits} />}
      {osd && listIdx === null && <Osd design={design} channel={channel} now={now} />}
      {listIdx !== null && <MiniList design={design} list={list.map(pick)} index={listIdx} currentId={channel.id} now={now} />}
      {prog !== null && <ProgramPanel channel={channel} sel={prog < 0 ? null : prog} items={program.items} pending={program.pending} error={program.error} />}
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function Osd({ design, channel, now }: { design: Design; channel: IptvChannel; now: number }) {
  const { t } = useI18n();
  const frac = epgProgress(channel.now, now);
  const terminal = design === "terminal";
  const panel =
    design === "projector" ? "tv-panel rounded-[28px]" : terminal ? "tv-panel tv-panel-bg border-l-[6px] border-accent" : "tv-panel rounded-card";
  return (
    <div data-testid="live-osd" className="absolute bottom-0 left-0 w-full">
      <div className="tv-scrim-bottom-strong absolute bottom-0 left-0 h-[420px] w-full" />
      <div className={`relative mx-[96px] mb-[64px] flex items-center px-10 py-8 ${panel}`}>
        <ChannelLogo channel={channel} w={200} h={150} className={`${terminal ? "" : "rounded-[16px]"} bg-white/10`} />
        <div className="ml-10 min-w-0 flex-1">
          <div className="flex items-baseline">
            <span data-testid="live-osd-number" className={`mr-6 text-[56px] font-extrabold leading-none text-accent ${terminal ? "font-mono" : ""}`}>
              {channel.number}
            </span>
            <span data-testid="live-osd-name" className={`truncate text-[48px] font-bold leading-tight text-text ${terminal ? "t-label" : ""}`}>
              {channel.name}
            </span>
            {channel.offline && <span className="ml-6 shrink-0 text-[24px] text-muted">{t("iptv.offline")}</span>}
            <span className={`ml-auto shrink-0 pl-6 text-[22px] font-bold uppercase text-danger ${terminal ? "t-label" : ""}`}>● {t("iptv.live")}</span>
          </div>
          {channel.now ? (
            <>
              <div className="mt-4 flex items-baseline text-[30px]">
                <span className={`mr-4 shrink-0 text-muted ${terminal ? "font-mono" : ""}`}>
                  {hhmm(channel.now.start)}–{hhmm(channel.now.stop)}
                </span>
                <span data-testid="live-osd-now" className="truncate text-text">
                  {channel.now.title}
                </span>
              </div>
              <EpgBar fraction={frac} className="mt-4 w-full" />
              {channel.next && (
                <p className="mt-4 truncate text-[26px] text-muted">
                  {t("iptv.next")} · {hhmm(channel.next.start)} · {channel.next.title}
                </p>
              )}
            </>
          ) : (
            <p className="mt-4 text-[28px] text-muted">{t("iptv.no_epg")}</p>
          )}
        </div>
      </div>
      <p className="tv-key-hint absolute right-[96px] top-[-56px] rounded-full px-6 py-2 text-[20px] text-text/80">{t("iptv.tv.keys_hint")}</p>
    </div>
  );
}

function Digits({ design, digits }: { design: Design; digits: string }) {
  return (
    <div
      data-testid="live-digits"
      className={`absolute right-[96px] top-[72px] px-10 py-4 text-[88px] font-extrabold leading-none text-accent ${
        design === "terminal" ? "tv-panel tv-panel-bg font-mono" : design === "projector" ? "tv-panel rounded-[28px]" : "tv-panel rounded-card"
      }`}
    >
      {digits}
      <span className="tv-caret text-text/60">_</span>
    </div>
  );
}

function MiniList({ design, list, index, currentId, now }: { design: Design; list: IptvChannel[]; index: number; currentId: string; now: number }) {
  const { t } = useI18n();
  // A window around the focused row; the column scrolls by whole rows.
  const first = Math.max(0, Math.min(index - Math.floor(LIST_ROWS / 2), list.length - LIST_ROWS));
  const rows = list.slice(first, first + LIST_ROWS);
  const terminal = design === "terminal";
  const bg = terminal ? "tv-panel tv-panel-bg border-r border-accent" : "tv-panel";
  return (
    <div data-testid="live-list" className={`absolute left-0 top-0 h-full w-[760px] ${bg}`}>
      <div className="flex h-[120px] items-end px-12 pb-5">
        <h2 className={`text-[34px] font-bold text-text ${terminal ? "t-label" : ""}`}>{t("iptv.channels")}</h2>
        <span className="mb-1 ml-auto text-[22px] text-muted">
          {index + 1} / {list.length}
        </span>
      </div>
      <div className="relative px-6" style={{ height: LIST_ROWS * ROW_H }}>
        {rows.map((c, i) => {
          const at = first + i;
          const focused = at === index;
          const frac = epgProgress(c.now, now);
          return (
            <div
              key={c.id}
              data-channel-id={c.id}
              className={`absolute left-6 right-6 flex items-center px-6 ${terminal ? "" : "rounded-control"} ${focused ? "is-focused bg-text text-bg" : "text-text"} ${
                c.offline ? "opacity-50" : ""
              }`}
              style={{ top: i * ROW_H, height: ROW_H - 8 }}
            >
              <span className={`w-[76px] shrink-0 text-[28px] font-bold ${focused ? "" : "text-muted"} ${terminal ? "font-mono" : ""}`}>{c.number}</span>
              <ChannelLogo channel={c} w={96} h={64} className="rounded-[10px] bg-white/10" />
              <span className="ml-5 min-w-0 flex-1">
                <span className="flex items-center">
                  <span className="truncate text-[28px] font-semibold">{c.name}</span>
                  {c.favorite && <span className="ml-3 shrink-0 text-[24px] text-accent">★</span>}
                  {c.id === currentId && <span className="ml-3 shrink-0 text-[20px] font-bold uppercase text-danger">●</span>}
                </span>
                <span className={`mt-1 block truncate text-[21px] ${focused ? "" : "text-muted"}`}>{c.now?.title ?? (c.offline ? t("iptv.offline") : t("iptv.no_epg"))}</span>
                {frac !== null && <EpgBar fraction={frac} className="mt-2 w-full" />}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
