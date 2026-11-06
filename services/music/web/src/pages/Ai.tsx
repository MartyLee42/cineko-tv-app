import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError, api, fmtTotal, tracksWord, type Track } from "../api";
import { useLibrary } from "../library";
import { usePlayer } from "../player";
import { toast } from "../toast";
import { BigPlay, DownloadButton, EqBars, TrackList } from "../ui";

type Creativity = "precise" | "normal" | "bold";

interface AiResult {
  /** The request was not about music: show `answer` instead of a playlist. */
  refused?: boolean;
  answer?: string;
  title: string;
  description: string;
  prompt: string;
  creativity?: Creativity;
  tracks: Track[];
  createdAt?: number;
  cached?: boolean;
}

const CREATIVITY: [Creativity, string, string][] = [
  ["precise", "Точнее", "Ближе к запросу, без неожиданностей"],
  ["normal", "Обычно", "Как обычно"],
  ["bold", "Смелее", "Больше неожиданных находок"],
];

const CREATIVITY_KEY = "martytv.music_ai_creativity";

function loadCreativity(): Creativity {
  try {
    const v = localStorage.getItem(CREATIVITY_KEY);
    return v === "precise" || v === "bold" ? v : "normal";
  } catch {
    return "normal";
  }
}

function builtAgo(at?: number): string {
  if (!at) return "";
  const days = Math.floor((Date.now() / 1000 - at) / 86400);
  return days <= 0 ? "собрано сегодня" : days === 1 ? "собрано вчера" : `собрано ${days} дн. назад`;
}

const CACHE = "mm.ai.last";

function cached(prompt: string, creativity: Creativity): AiResult | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(CACHE) || "null") as AiResult | null;
    return r && r.prompt === prompt && (r.creativity ?? "normal") === creativity ? r : null;
  } catch {
    return null;
  }
}

/** An AI playlist for ?prompt= (kept for the tab session, so Back doesn't regenerate). */
export function AiPage() {
  const [params] = useSearchParams();
  const prompt = params.get("prompt") ?? "";
  const navigate = useNavigate();
  const player = usePlayer();
  const lib = useLibrary();
  const [creativity, setCreativity] = useState<Creativity>(loadCreativity);
  const [res, setRes] = useState<AiResult | null>(() => cached(prompt, creativity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(prompt);

  const generate = async (avoid: string[] = [], fresh = false, level: Creativity = creativity) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<AiResult>("/ai/playlist", { prompt, avoid, fresh, creativity: level });
      setRes(r);
      try {
        sessionStorage.setItem(CACHE, JSON.stringify(r));
      } catch {
        /* quota */
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  };

  const pickCreativity = (c: Creativity) => {
    if (c === creativity) return;
    setCreativity(c);
    try {
      localStorage.setItem(CREATIVITY_KEY, c);
    } catch {
      /* private mode */
    }
    if (!prompt || busy) return;
    const hit = cached(prompt, c);
    if (hit) setRes(hit);
    else void generate([], false, c);
  };

  useEffect(() => {
    setText(prompt);
    if (prompt && !cached(prompt, creativity)) void generate();
    else setRes(cached(prompt, creativity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);

  const tracks = res?.tracks ?? [];
  const ctx = { type: "other" as const, name: res?.title ?? "ИИ-подборка", href: `/ai?prompt=${encodeURIComponent(prompt)}` };
  const dur = tracks.reduce((s, t) => s + (t.duration || 0), 0);

  return (
    <div className="page">
      <form
        className="ai-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) navigate(`/ai?prompt=${encodeURIComponent(text.trim())}`);
        }}
      >
        <span className="ai-spark">✦</span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Опишите, что хочется послушать" maxLength={300} />
        <button className="btn primary small" disabled={!text.trim() || busy}>
          Собрать
        </button>
      </form>
      <div className="chips ai-creativity" role="radiogroup" aria-label="Смелость подборки">
        {CREATIVITY.map(([c, label, hint]) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={creativity === c}
            className={`chip ${creativity === c ? "on" : ""}`}
            title={hint}
            disabled={busy}
            onClick={() => pickCreativity(c)}
          >
            {label}
          </button>
        ))}
      </div>

      {busy && (
        <div className="ai-busy">
          <EqBars /> ИИ собирает подборку «{prompt}»… это занимает до минуты
        </div>
      )}
      {error && !busy && (
        <div className="error-box">
          <p>{error}</p>
          <button className="btn" onClick={() => void generate()}>
            Повторить
          </button>
        </div>
      )}
      {res?.refused && !busy && (
        <div className="ai-refused">
          <span className="ai-spark">✦</span>
          <p>{res.answer || "Я могу помочь только с подбором музыки."}</p>
          <p className="ai-refused-hint">Например: «вечер под дождём», «русский рок 90-х», «музыка для пробежки»</p>
        </div>
      )}
      {res && !res.refused && !busy && (
        <>
          <header className="hero ai-hero">
            <div className="hero-art ai-art">
              <span>✦</span>
            </div>
            <div className="hero-text">
              <div className="hero-kind">ИИ-подборка</div>
              <h1 className={res.title.length > 28 ? "long" : ""}>{res.title}</h1>
              <div className="hero-meta">
                {tracksWord(tracks.length)}
                {dur > 0 && `, ${fmtTotal(dur)}`}
                {res.createdAt ? ` · ${builtAgo(res.createdAt)}` : ""}
              </div>
              {res.description && <p className="hero-desc">{res.description}</p>}
            </div>
          </header>
          <div className="actions">
            <BigPlay onClick={() => player.playList(tracks, 0, ctx)} disabled={!tracks.length} />
            <DownloadButton tracks={tracks} />
            <button
              className="btn ghost"
              onClick={async () => {
                try {
                  const id = await lib.createPlaylist(res.title, tracks);
                  navigate(`/my/${id}`);
                } catch (e) {
                  toast((e as Error).message);
                }
              }}
            >
              Сохранить как плейлист
            </button>
            <button className="btn ghost" onClick={() => void generate(tracks.map((t) => `${t.artist} — ${t.title}`))}>
              ✦ Другой вариант
            </button>
            {res.cached && (
              <button className="btn ghost" onClick={() => void generate([], true)} title="Собрать заново с учётом свежих вкусов">
                Обновить
              </button>
            )}
          </div>
          <TrackList tracks={tracks} context={ctx} showAlbum />
        </>
      )}
    </div>
  );
}
