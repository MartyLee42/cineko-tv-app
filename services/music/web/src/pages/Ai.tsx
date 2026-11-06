import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError, api, fmtTotal, tracksWord, type Track } from "../api";
import { useLibrary } from "../library";
import { usePlayer } from "../player";
import { toast } from "../toast";
import { BigPlay, DownloadButton, EqBars, TrackList } from "../ui";

interface AiResult {
  title: string;
  description: string;
  prompt: string;
  tracks: Track[];
  createdAt?: number;
  cached?: boolean;
}

function builtAgo(at?: number): string {
  if (!at) return "";
  const days = Math.floor((Date.now() / 1000 - at) / 86400);
  return days <= 0 ? "собрано сегодня" : days === 1 ? "собрано вчера" : `собрано ${days} дн. назад`;
}

const CACHE = "mm.ai.last";

function cached(prompt: string): AiResult | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(CACHE) || "null") as AiResult | null;
    return r && r.prompt === prompt ? r : null;
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
  const [res, setRes] = useState<AiResult | null>(() => cached(prompt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(prompt);

  const generate = async (avoid: string[] = [], fresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<AiResult>("/ai/playlist", { prompt, avoid, fresh });
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

  useEffect(() => {
    setText(prompt);
    if (prompt && !cached(prompt)) void generate();
    else setRes(cached(prompt));
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
      {res && !busy && (
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
