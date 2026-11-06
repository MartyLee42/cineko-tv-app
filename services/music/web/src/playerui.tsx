import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, fmtTime, img, sized, type Lyrics, type Track } from "./api";
import {
  ChevronDownIcon, CloseIcon, ExpandIcon, LyricsIcon, MoreIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, QueueIcon, RepeatIcon,
  ShuffleIcon, VolumeIcon,
} from "./icons";
import { usePlayer, useTime } from "./player";
import { useScrollLock } from "./scrolllock";
import { ArtistLinks, Cover, EqBars, LikeButton, TrackDownload, openMenu, tabLinks, useTrackMenu } from "./ui";

export type Panel = "queue" | "lyrics" | null;

// ---------------------------------------------------------------- seek bar

export function SeekBar({ compact }: { compact?: boolean }) {
  const p = usePlayer();
  const { time, duration: loaded, buffering } = useTime();
  const duration = loaded || p.current?.duration || 0;
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? time;
  const max = duration > 0 ? duration : 1;
  const pct = Math.min(100, (shown / max) * 100);
  const commit = () => {
    if (drag !== null) p.seek(drag);
    setDrag(null);
  };
  return (
    <div className={`seek ${compact ? "compact" : ""}`}>
      {!compact && <span className="seek-t">{fmtTime(shown)}</span>}
      <div className={`range-wrap ${buffering && p.playing ? "buffering" : ""}`}>
        <input
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={Math.min(shown, max)}
          disabled={!p.current}
          aria-label="Позиция"
          style={{ ["--pct" as string]: `${pct}%` }}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          onBlur={() => drag !== null && commit()}
        />
      </div>
      {!compact && <span className="seek-t">{duration > 0 ? fmtTime(duration) : "--:--"}</span>}
    </div>
  );
}

function Controls({ big }: { big?: boolean }) {
  const p = usePlayer();
  const { buffering } = useTime();
  const s = big ? 30 : 18;
  return (
    <div className={`controls ${big ? "big" : ""}`}>
      <button className={`icon-btn ${p.shuffle ? "on" : ""}`} title="Перемешать" aria-pressed={p.shuffle} onClick={p.toggleShuffle}>
        <ShuffleIcon size={big ? 22 : 18} />
      </button>
      <button className="icon-btn" title="Предыдущий" onClick={p.prev} disabled={!p.current}>
        <PrevIcon size={s} />
      </button>
      <button className={`play-btn ${big ? "big" : ""} ${buffering && p.playing ? "busy" : ""}`} title={p.playing ? "Пауза" : "Играть"} onClick={p.toggle} disabled={!p.current}>
        {p.playing ? <PauseIcon size={big ? 30 : 20} /> : <PlayIcon size={big ? 30 : 20} />}
      </button>
      <button className="icon-btn" title="Следующий" onClick={p.next} disabled={!p.current}>
        <NextIcon size={s} />
      </button>
      <button
        className={`icon-btn ${p.repeat !== "off" ? "on" : ""}`}
        title={p.repeat === "one" ? "Повтор трека" : p.repeat === "all" ? "Повтор очереди" : "Повтор выключен"}
        onClick={p.cycleRepeat}
      >
        <RepeatIcon size={big ? 22 : 18} one={p.repeat === "one"} />
      </button>
    </div>
  );
}

function Volume() {
  const p = usePlayer();
  const v = p.muted ? 0 : p.volume;
  return (
    <div className="volume">
      <button className="icon-btn" title={p.muted ? "Включить звук" : "Без звука"} onClick={p.toggleMute}>
        <VolumeIcon size={18} level={v === 0 ? 0 : v} />
      </button>
      <div className="range-wrap">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={v}
          aria-label="Громкость"
          style={{ ["--pct" as string]: `${v * 100}%` }}
          onChange={(e) => p.setVolume(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bar

export function PlayerBar({ panel, setPanel, onExpand }: { panel: Panel; setPanel: (p: Panel) => void; onExpand: () => void }) {
  const p = usePlayer();
  const t = p.current;
  const { time, duration } = useTime();
  const menu = useTrackMenu();
  if (!t) return <footer className="player-bar empty" />;
  return (
    <footer className="player-bar">
      <div className="mini-progress" style={{ width: `${duration > 0 ? Math.min(100, (time / duration) * 100) : 0}%` }} />
      <div className="pb-left" onClick={() => window.innerWidth < 760 && onExpand()}>
        <Cover src={t.cover} size={120} className="pb-cover" />
        <div className="pb-text">
          <div className="pb-title">
            {t.albumId ? <Link to={`/album/${t.albumId}`} onClick={(e) => e.stopPropagation()}>{t.title}</Link> : t.title}
            {t.src?.lossless && <span className="badge-l">{t.src.ext.toUpperCase()}</span>}
          </div>
          <div className="pb-artist">
            <ArtistLinks track={t} />
          </div>
        </div>
        <TrackDownload track={t} />
        <LikeButton track={t} />
        <button
          className="icon-btn mobile-only"
          onClick={(e) => {
            e.stopPropagation();
            p.toggle();
          }}
          title={p.playing ? "Пауза" : "Играть"}
        >
          {p.playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
        </button>
      </div>
      <div className="pb-center">
        <WinampLcd />
        <Controls />
        <SeekBar />
      </div>
      <div className="pb-right">
        <button className="icon-btn" title="Ещё" onClick={(e) => menu(e, t)}>
          <MoreIcon size={18} />
        </button>
        <button className={`icon-btn ${panel === "lyrics" ? "on" : ""}`} title="Текст песни" onClick={() => setPanel(panel === "lyrics" ? null : "lyrics")}>
          <LyricsIcon size={18} />
        </button>
        <button className={`icon-btn ${panel === "queue" ? "on" : ""}`} title="Очередь" onClick={() => setPanel(panel === "queue" ? null : "queue")}>
          <QueueIcon size={18} />
        </button>
        <Volume />
        <button className="icon-btn" title="Во весь экран" onClick={onExpand}>
          <ExpandIcon size={17} />
        </button>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------- side panel

export function SidePanel({ panel, close }: { panel: Panel; close: () => void }) {
  if (!panel) return null;
  return (
    <aside className="side-panel">
      <div className="side-head">
        <h3>{panel === "queue" ? "Очередь" : "Текст песни"}</h3>
        <button className="icon-btn" onClick={close} title="Закрыть">
          <CloseIcon size={18} />
        </button>
      </div>
      <div className="side-body">{panel === "queue" ? <QueueView /> : <LyricsView />}</div>
    </aside>
  );
}

export function QueueView({ onNavigate }: { onNavigate?: () => void }) {
  const p = usePlayer();
  const upcoming = p.queue.slice(p.index + 1, p.index + 101);
  const t = p.current;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="queue" ref={ref}>
      {t && (
        <>
          <div className="q-label">Сейчас играет</div>
          <QueueRow track={t} active />
          {p.context?.name && (
            <div className="q-from muted small">
              Играет из:{" "}
              {p.context.href ? (
                <Link to={p.context.href} onClick={onNavigate}>
                  {p.context.name}
                </Link>
              ) : (
                p.context.name
              )}
            </div>
          )}
        </>
      )}
      <div className="q-label row">
        <span>Далее</span>
        {upcoming.length > 0 && (
          <button className="link small" onClick={p.clearUpcoming}>
            Очистить
          </button>
        )}
      </div>
      {upcoming.length === 0 && (
        <p className="muted small">
          {p.autoplay ? "Дальше включим похожие треки." : "Очередь пуста."}{" "}
          <label className="autoplay">
            <input type="checkbox" checked={p.autoplay} onChange={(e) => p.setAutoplay(e.target.checked)} /> Автовоспроизведение похожих
          </label>
        </p>
      )}
      {upcoming.map((tr, k) => {
        const i = p.index + 1 + k;
        return (
          <QueueRow
            key={`${tr.id}-${i}`}
            track={tr}
            onPlay={() => p.jumpTo(i)}
            onRemove={() => p.removeAt(i)}
            onUp={k > 0 ? () => p.moveInQueue(i, i - 1) : undefined}
            onDown={k < upcoming.length - 1 ? () => p.moveInQueue(i, i + 1) : undefined}
          />
        );
      })}
    </div>
  );
}

function QueueRow({ track, active, onPlay, onRemove, onUp, onDown }: { track: Track; active?: boolean; onPlay?: () => void; onRemove?: () => void; onUp?: () => void; onDown?: () => void }) {
  const p = usePlayer();
  return (
    <div className={`q-row ${active ? "active" : ""}`} onDoubleClick={onPlay} onClick={() => window.innerWidth < 760 && onPlay?.()}>
      <div className="q-art">
        <Cover src={track.cover} size={120} />
        {active && p.playing && (
          <span className="q-eq">
            <EqBars />
          </span>
        )}
        {onPlay && (
          <button className="q-play" onClick={(e) => { e.stopPropagation(); onPlay(); }} title="Играть">
            <PlayIcon size={16} />
          </button>
        )}
      </div>
      <div className="q-text">
        <div className="q-title">{track.title}</div>
        <div className="q-artist muted">{track.artist}</div>
      </div>
      <div className="q-actions">
        {onUp && <button className="icon-btn tiny" title="Выше" onClick={(e) => { e.stopPropagation(); onUp(); }}>↑</button>}
        {onDown && <button className="icon-btn tiny" title="Ниже" onClick={(e) => { e.stopPropagation(); onDown(); }}>↓</button>}
        {onRemove && (
          <button className="icon-btn tiny" title="Убрать" onClick={(e) => { e.stopPropagation(); onRemove(); }}>
            <CloseIcon size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- lyrics

interface Line {
  t: number;
  text: string;
}

function parseLrc(lrc: string): Line[] {
  const out: Line[] = [];
  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function LyricsView() {
  const p = usePlayer();
  const t = p.current;
  const { time } = useTime();
  const q = useQuery({
    queryKey: ["lyrics", t?.artist, t?.title, t?.duration],
    enabled: !!t,
    staleTime: Infinity,
    queryFn: () =>
      api.get<Lyrics>(
        `/lyrics?${new URLSearchParams({ artist: t!.artist, title: t!.title, album: t!.album ?? "", duration: String(t!.duration || 0) })}`,
      ),
  });
  const lines = useMemo(() => (q.data?.synced ? parseLrc(q.data.synced) : []), [q.data]);
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.t <= time + 0.25) active = i;
    else break;
  }
  const box = useRef<HTMLDivElement>(null);
  const userScroll = useRef(0);
  useEffect(() => {
    if (active < 0 || !box.current || Date.now() - userScroll.current < 4000) return;
    const el = box.current.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);
  if (!t) return <p className="muted">Ничего не играет.</p>;
  if (q.isLoading) return <p className="muted">Ищем текст…</p>;
  if (q.error) return <p className="muted">Текст недоступен.</p>;
  if (q.data?.instrumental) return <p className="muted">Инструментальный трек ♪</p>;
  if (lines.length) {
    return (
      <div className="lyrics synced" ref={box} onWheel={() => (userScroll.current = Date.now())} onTouchMove={() => (userScroll.current = Date.now())}>
        {lines.map((l, i) => (
          <p key={i} data-i={i} className={i === active ? "on" : i < active ? "past" : ""} onClick={() => p.seek(l.t)}>
            {l.text || "♪"}
          </p>
        ))}
        <div className="lyrics-src muted small">Текст: LRCLIB</div>
      </div>
    );
  }
  if (q.data?.plain) {
    return (
      <div className="lyrics plain">
        {q.data.plain.split("\n").map((l, i) => (
          <p key={i}>{l || " "}</p>
        ))}
        <div className="lyrics-src muted small">Текст: LRCLIB</div>
      </div>
    );
  }
  return <p className="muted">Текст для этого трека не нашли.</p>;
}

// ---------------------------------------------------------------- full screen

export function NowPlaying({ close }: { close: () => void }) {
  const p = usePlayer();
  const t = p.current;
  const navigate = useNavigate();
  const menu = useTrackMenu();
  const [tab, setTab] = useState<"cover" | "lyrics" | "queue">("cover");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  useScrollLock();
  if (!t) return null;
  const art = t.coverBig ?? t.cover;
  const go = (to: string) => {
    close();
    navigate(to);
  };
  return (
    <div className="now-playing">
      <div className="np-bg" style={art ? { backgroundImage: `url(${img(sized(art, 250))})` } : undefined} />
      <div className="np-top">
        <button className="icon-btn" onClick={close} title="Свернуть">
          <ChevronDownIcon size={26} />
        </button>
        <div className="np-from">
          {p.context?.name && (
            <>
              <div className="muted small">Играет из</div>
              <div className="np-ctx" onClick={() => p.context?.href && go(p.context.href)}>
                {p.context.name}
              </div>
            </>
          )}
        </div>
        <button className="icon-btn" onClick={(e) => menu(e, t)} title="Ещё">
          <MoreIcon size={22} />
        </button>
      </div>
      <div className={`np-main tab-${tab}`}>
        <div className="np-art">
          <Cover src={art} size={1000} />
        </div>
        <div className="np-panel">{tab === "lyrics" ? <LyricsView /> : tab === "queue" ? <QueueView onNavigate={close} /> : null}</div>
      </div>
      <div className="np-info">
        <div className="np-text">
          <div className="np-title" onClick={() => t.albumId && go(`/album/${t.albumId}`)}>
            {t.title}
            {t.src?.lossless && <span className="badge-l">{t.src.ext.toUpperCase()}</span>}
          </div>
          <div className="np-artist" onClick={() => t.artistId && go(`/artist/${t.artistId}`)}>
            {t.artist}
          </div>
        </div>
        <TrackDownload track={t} size={24} />
        <LikeButton track={t} size={26} />
      </div>
      <div className="np-seek">
        <SeekBar />
      </div>
      <Controls big />
      <div className="np-tabs">
        <button className={tab === "lyrics" ? "on" : ""} onClick={() => setTab(tab === "lyrics" ? "cover" : "lyrics")}>
          <LyricsIcon size={18} /> Текст
        </button>
        <button className={tab === "queue" ? "on" : ""} onClick={() => setTab(tab === "queue" ? "cover" : "queue")}>
          <QueueIcon size={18} /> Очередь
        </button>
        <button onClick={(e) => openMenu(e, tabLinks(t), "Табы и аккорды")}>🎸 Табы</button>
      </div>
    </div>
  );
}


/** Winamp-style LCD: green time, scrolling title, spectrum bars (shown by the Winamp design only). */
function WinampLcd() {
  const p = usePlayer();
  const { time } = useTime();
  const t = p.current;
  if (!t) return null;
  const m = Math.floor(time / 60);
  const sec = Math.floor(time % 60);
  const label = `${p.index + 1}. ${t.artist} - ${t.title} (${fmtTime(t.duration)})`;
  return (
    <div className={`wa-lcd ${p.playing ? "playing" : ""}`} aria-hidden="true">
      <div className="wa-state">{p.playing ? "▶" : "❚❚"}</div>
      <div className="wa-time">
        {String(m).padStart(2, " ")}:{String(sec).padStart(2, "0")}
      </div>
      <div className="wa-viz">
        {Array.from({ length: 16 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${-((i * 137) % 900)}ms`, animationDuration: `${520 + ((i * 53) % 480)}ms` }} />
        ))}
      </div>
      <div className="wa-marquee">
        <span>
          {label} *** {label} ***{" "}
        </span>
      </div>
      <div className="wa-info">
        <span>{t.src?.lossless ? "1411" : "128"}</span> kbps <span>44</span> kHz
      </div>
    </div>
  );
}
