import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, plural, type Album, type Chart, type DzPlaylist, type Home as HomeData, type Me, type Track } from "../api";
import { HeartIcon, PauseIcon, PlayIcon, WaveIcon } from "../icons";
import { useLibrary } from "../library";
import { usePlayer } from "../player";
import { toast } from "../toast";
import { Card, Cover, ErrorBox, Loading, Shelf, TrackList, playRadio } from "../ui";
import { PulsarArt } from "../backdrop";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

export function usePlayAlbum() {
  const player = usePlayer();
  return async (a: Album) => {
    try {
      const full = await api.get<Album>(`/album/${a.id}`);
      player.playList(full.tracks ?? [], 0, { type: "album", id: a.id, name: a.title, href: `/album/${a.id}` });
    } catch (e) {
      toast((e as Error).message);
    }
  };
}

export function usePlayDzPlaylist() {
  const player = usePlayer();
  return async (p: DzPlaylist) => {
    try {
      const full = await api.get<DzPlaylist>(`/playlist/${p.id}`);
      player.playList(full.tracks ?? [], 0, { type: "playlist", id: p.id, name: p.title, href: `/playlist/${p.id}` });
    } catch (e) {
      toast((e as Error).message);
    }
  };
}

// «Моя волна» settings (kept on this device).
export interface WaveSettings {
  character: "" | "favorite" | "discover" | "popular";
  mood: "" | "energetic" | "happy" | "calm" | "sad";
  activity: "" | "wake" | "work" | "workout" | "road" | "sleep";
  lang: "" | "ru" | "foreign";
}

const WAVE_KEY = "mm.wave.v1";
const emptyWave: WaveSettings = { character: "", mood: "", activity: "", lang: "" };

export function loadWave(): WaveSettings {
  try {
    return { ...emptyWave, ...(JSON.parse(localStorage.getItem(WAVE_KEY) || "{}") as Partial<WaveSettings>) };
  } catch {
    return emptyWave;
  }
}

function waveQuery(w: WaveSettings): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(w)) if (v) q.set(k, v);
  return q.toString();
}

export function useFlow() {
  const player = usePlayer();
  const [busy, setBusy] = useState(false);
  const [settings, setSettingsState] = useState<WaveSettings>(loadWave);
  const active = player.context?.type === "flow" && !player.context.id;
  const run = async (w: WaveSettings) => {
    setBusy(true);
    try {
      const params = waveQuery(w);
      const ts = await api.get<Track[]>(`/flow${params ? `?${params}` : ""}`);
      if (!ts.length) {
        toast("Ничего не нашлось — попробуйте другие настройки");
        return;
      }
      player.playList(ts, 0, { type: "flow", name: "Моя волна", params });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (active) {
      player.toggle();
      return;
    }
    await run(settings);
  };
  const setSettings = (w: WaveSettings) => {
    setSettingsState(w);
    try {
      localStorage.setItem(WAVE_KEY, JSON.stringify(w));
    } catch {
      /* private mode */
    }
    // Playing the wave: switch to the new settings right away.
    if (active) void run(w);
  };
  return { start, busy, active, playing: active && player.playing, settings, setSettings };
}

const WAVE_GROUPS: { key: keyof WaveSettings; title: string; options: [string, string][] }[] = [
  { key: "character", title: "Характер", options: [["favorite", "Любимое"], ["discover", "Незнакомое"], ["popular", "Популярное"]] },
  { key: "mood", title: "Настроение", options: [["energetic", "Бодрое"], ["happy", "Весёлое"], ["calm", "Спокойное"], ["sad", "Грустное"]] },
  { key: "activity", title: "Занятие", options: [["wake", "Просыпаюсь"], ["work", "Работаю"], ["workout", "Тренируюсь"], ["road", "В дороге"], ["sleep", "Засыпаю"]] },
  { key: "lang", title: "Язык", options: [["ru", "Русский"], ["foreign", "Иностранный"]] },
];

export function waveSummary(w: WaveSettings): string {
  const parts = WAVE_GROUPS.map((g) => g.options.find(([v]) => v === w[g.key])?.[1]).filter(Boolean);
  return parts.length ? parts.join(" · ") : "Бесконечный поток по вашему вкусу";
}

export function WaveSettingsPanel({ value, onChange }: { value: WaveSettings; onChange: (w: WaveSettings) => void }) {
  return (
    <div className="wave-settings">
      {WAVE_GROUPS.map((g) => (
        <div key={g.key} className="wave-group">
          <div className="wave-group-title">{g.title}</div>
          <div className="chips wrap">
            {g.options.map(([v, label]) => (
              <button
                key={v}
                className={`chip ${value[g.key] === v ? "on" : ""}`}
                onClick={() => onChange({ ...value, [g.key]: value[g.key] === v ? "" : v })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const AI_PRESETS = [
  "Похоже на мои любимые, но новое",
  "Вечер под дождём",
  "Русский рок 90-х",
  "Энергичная тренировка",
  "Музыка для концентрации без слов",
  "Песни для поездки на машине летом",
  "Грустный инди",
  "Ностальгия по 2000-м",
];

export function AiSection() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const go = (p: string) => p.trim() && navigate(`/ai?prompt=${encodeURIComponent(p.trim())}`);
  return (
    <section className="shelf ai-section">
      <div className="shelf-head">
        <h2>ИИ-подборки</h2>
      </div>
      <form
        className="ai-box"
        onSubmit={(e) => {
          e.preventDefault();
          go(text);
        }}
      >
        <span className="ai-spark">✦</span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Опишите, что хочется послушать: настроение, повод, жанр…" maxLength={300} />
        <button className="btn primary small" disabled={!text.trim()}>
          Собрать
        </button>
      </form>
      <div className="chips wrap">
        {AI_PRESETS.map((p) => (
          <button key={p} className="chip" onClick={() => go(p)}>
            {p}
          </button>
        ))}
      </div>
    </section>
  );
}

export function HomePage() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
  const q = useQuery({ queryKey: ["home"], queryFn: () => api.get<HomeData>("/home"), staleTime: 5 * 60_000 });
  const lib = useLibrary();
  const player = usePlayer();
  const playAlbum = usePlayAlbum();
  const playPl = usePlayDzPlaylist();
  const flow = useFlow();
  const [tune, setTune] = useState(false);
  const name = me.data?.user.displayName;

  return (
    <div className="page home">
      <h1 className="greeting">
        {greeting()}
        {name ? `, ${name}` : ""}
      </h1>

      <div className="wave-wrap">
        <button className={`wave ${flow.playing ? "playing" : ""}`} onClick={() => void flow.start()} disabled={flow.busy}>
          <div className="wave-anim">
            <WaveIcon size={44} />
            <PulsarArt />
          </div>
          <div className="wave-text">
            <div className="wave-title">Моя волна</div>
            <div className="wave-sub">{flow.active ? (flow.playing ? "Играет — нажмите для паузы" : "На паузе") : waveSummary(flow.settings)}</div>
          </div>
          <div className="wave-play">{flow.busy ? <span className="spinner" /> : flow.playing ? <PauseIcon size={26} /> : <PlayIcon size={26} />}</div>
        </button>
        <button className={`wave-tune ${tune ? "on" : ""}`} onClick={() => setTune(!tune)} title="Настроить волну">
          ⚙ Настроить
        </button>
      </div>
      {tune && <WaveSettingsPanel value={flow.settings} onChange={flow.setSettings} />}

      <div className="quick">
        <Link to="/liked" className="quick-tile liked">
          <div className="quick-art liked-art">
            <HeartIcon size={22} filled />
          </div>
          <span>Любимые треки</span>
          <span className="muted small">{lib.likesCount}</span>
        </Link>
        {lib.playlists.slice(0, 3).map((p) => (
          <Link key={p.id} to={`/my/${p.id}`} className="quick-tile">
            <Cover src={p.covers?.[0]} size={120} className="quick-art" />
            <span>{p.name}</span>
          </Link>
        ))}
        {(q.data?.recentAlbums ?? []).slice(0, 4).map((a) => (
          <Link key={a.id} to={`/album/${a.id}`} className="quick-tile">
            <Cover src={a.cover} size={120} className="quick-art" />
            <span>{a.title}</span>
          </Link>
        ))}
      </div>

      {me.data?.features.ai && <AiSection />}

      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} retry={() => void q.refetch()} />}
      {q.data && (
        <>
          {q.data.mixes.length > 0 && (
            <Shelf title="Миксы для вас">
              {q.data.mixes.map((a) => (
                <Card
                  key={a.id}
                  to={`/artist/${a.id}`}
                  cover={a.picture}
                  title={`Микс: ${a.name}`}
                  subtitle="Исполнитель и похожие"
                  onPlay={() => void playRadio(player, a.id, a.name)}
                  playing={player.playing && player.context?.type === "radio" && player.context.id === a.id}
                />
              ))}
            </Shelf>
          )}
          {q.data.recent.length > 0 && (
            <section className="shelf">
              <div className="shelf-head">
                <h2>Недавно слушали</h2>
                <Link to="/history" className="shelf-more">
                  Все
                </Link>
              </div>
              <TrackList tracks={q.data.recent.slice(0, 5)} context={{ type: "history", name: "Недавно слушали", href: "/history" }} />
            </section>
          )}
          <ChartSections chart={q.data.chart} playAlbum={playAlbum} playPl={playPl} />
        </>
      )}
    </div>
  );
}

export function ChartSections({ chart, playAlbum, playPl, title = "Популярное сейчас" }: { chart: Chart; playAlbum: (a: Album) => void; playPl: (p: DzPlaylist) => void; title?: string }) {
  return (
    <>
      {chart.tracks.length > 0 && (
        <section className="shelf">
          <div className="shelf-head">
            <h2>{title}</h2>
            <Link to="/chart" className="shelf-more">
              Все
            </Link>
          </div>
          <TrackList tracks={chart.tracks.slice(0, 10)} context={{ type: "chart", name: title, href: "/chart" }} showAlbum />
        </section>
      )}
      {chart.albums.length > 0 && (
        <Shelf title="Популярные альбомы">
          {chart.albums.map((a) => (
            <Card key={a.id} to={`/album/${a.id}`} cover={a.cover} title={a.title} subtitle={a.artist} onPlay={() => playAlbum(a)} />
          ))}
        </Shelf>
      )}
      {chart.artists.length > 0 && (
        <Shelf title="Популярные исполнители">
          {chart.artists.map((a) => (
            <Card key={a.id} to={`/artist/${a.id}`} cover={a.picture} title={a.name} subtitle="Исполнитель" round />
          ))}
        </Shelf>
      )}
      {chart.playlists.length > 0 && (
        <Shelf title="Плейлисты">
          {chart.playlists.slice(0, 20).map((p) => (
            <Card
              key={p.id}
              to={`/playlist/${p.id}`}
              cover={p.picture}
              title={p.title}
              subtitle={p.count ? `${p.count} ${plural(p.count, "трек", "трека", "треков")}` : p.owner}
              onPlay={() => playPl(p)}
            />
          ))}
        </Shelf>
      )}
    </>
  );
}
