import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { Empty, ErrorBox, Loading } from "../ui";

interface TabRef {
  id: number;
  song: string;
  artist: string;
  type: string;
  rating: number;
  votes: number;
  url: string;
}

interface TabSheet extends TabRef {
  tuning?: string;
  capo?: number;
  content: string;
}

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT: Record<string, string> = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E" };

function shiftNote(n: string, by: number): string {
  const base = FLAT[n] ?? n;
  const i = NOTES.indexOf(base);
  if (i < 0) return n;
  return NOTES[(((i + by) % 12) + 12) % 12]!;
}

/** Transposes a chord name: "F#m7/C#" +2 → "G#m7/D#". */
export function transposeChord(ch: string, by: number): string {
  if (!by) return ch;
  return ch.replace(/^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?/, (_m, root: string, rest: string, bass?: string) =>
    shiftNote(root, by) + rest + (bass ? "/" + shiftNote(bass, by) : ""),
  );
}

/** UG markup ([ch]Am[/ch], [tab]…[/tab]) → text with highlighted chords. */
function renderSheet(content: string, by: number): ReactNode[] {
  const text = content.replace(/\[\/?tab\]/g, "").replace(/\r/g, "");
  const out: ReactNode[] = [];
  const re = /\[ch\]([\s\S]*?)\[\/ch\]/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <b key={k++} className="chord">
        {transposeChord(m[1]!, by)}
      </b>,
    );
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function scroller(): { el: HTMLElement | Window; by: (px: number) => void } {
  const main = document.querySelector<HTMLElement>(".main");
  if (main && main.scrollHeight > main.clientHeight + 4 && getComputedStyle(main).overflowY !== "visible") {
    return { el: main, by: (px) => main.scrollBy(0, px) };
  }
  return { el: window, by: (px) => window.scrollBy(0, px) };
}

export function TabsPage() {
  const [params] = useSearchParams();
  const artist = params.get("artist") ?? "";
  const title = params.get("title") ?? "";
  const q = params.get("q") ?? (title ? `${artist} — ${title}` : "");
  const list = useQuery({
    queryKey: ["tabs", artist, title, params.get("q")],
    enabled: !!q,
    staleTime: Infinity,
    queryFn: () =>
      api.get<TabRef[]>(`/tabs/search?${title ? new URLSearchParams({ artist, title }) : new URLSearchParams({ q })}`),
  });
  const [pick, setPick] = useState<string | null>(null);
  const chosen = pick ?? list.data?.[0]?.url ?? null;
  const sheet = useQuery({
    queryKey: ["tab", chosen],
    enabled: !!chosen,
    staleTime: Infinity,
    queryFn: () => api.get<TabSheet>(`/tabs/sheet?url=${encodeURIComponent(chosen!)}`),
  });
  const [shift, setShift] = useState(0);
  const [size, setSize] = useState(() => Number(localStorage.getItem("mm.tabs.size") || 15));
  const [speed, setSpeed] = useState(0); // px per second; 0 = off
  useEffect(() => {
    try {
      localStorage.setItem("mm.tabs.size", String(size));
    } catch {
      /* ignore */
    }
  }, [size]);
  const acc = useRef(0);
  useEffect(() => {
    if (!speed) return;
    let raf = 0;
    let prev = performance.now();
    const s = scroller();
    const step = (t: number) => {
      acc.current += ((t - prev) / 1000) * speed;
      prev = t;
      if (acc.current >= 1) {
        const px = Math.floor(acc.current);
        acc.current -= px;
        s.by(px);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [speed]);
  useEffect(() => setShift(0), [chosen]);
  const body = useMemo(() => (sheet.data ? renderSheet(sheet.data.content, shift) : null), [sheet.data, shift]);

  if (!q) return <Empty>Не указана песня.</Empty>;
  return (
    <div className="page tabs-page">
      <h1 className="page-title">Аккорды и табы</h1>
      <p className="muted small">{q}</p>
      {list.isLoading && <Loading />}
      {list.error && <ErrorBox error={list.error} retry={() => void list.refetch()} />}
      {list.data && list.data.length === 0 && <Empty>На Ultimate Guitar нет табов именно этой песни.</Empty>}
      {list.data && list.data.length > 0 && (
        <>
          <div className="chips tab-versions">
            {list.data.slice(0, 12).map((t, i) => (
              <button key={t.url} className={`chip ${t.url === chosen ? "on" : ""}`} onClick={() => setPick(t.url)} title={`${t.artist} — ${t.song}`}>
                {t.type === "Chords" ? "Аккорды" : t.type === "Tabs" ? "Табы" : t.type === "Bass Tabs" ? "Бас" : "Укулеле"} {i > 0 || t.votes ? `★${t.rating.toFixed(1)}` : ""}
                {t.votes ? <span className="muted"> · {t.votes}</span> : null}
              </button>
            ))}
          </div>
          <div className="tab-tools">
            <div className="tool">
              <span className="muted small">Тональность</span>
              <button className="btn small" onClick={() => setShift((s) => s - 1)}>
                −
              </button>
              <b className="tool-val">{shift > 0 ? `+${shift}` : shift}</b>
              <button className="btn small" onClick={() => setShift((s) => s + 1)}>
                +
              </button>
            </div>
            <div className="tool">
              <span className="muted small">Шрифт</span>
              <button className="btn small" onClick={() => setSize((s) => Math.max(10, s - 1))}>
                A−
              </button>
              <button className="btn small" onClick={() => setSize((s) => Math.min(28, s + 1))}>
                A+
              </button>
            </div>
            <div className="tool">
              <span className="muted small">Прокрутка</span>
              {[0, 10, 20, 35].map((v) => (
                <button key={v} className={`chip ${speed === v ? "on" : ""}`} onClick={() => setSpeed(v)}>
                  {v === 0 ? "Выкл" : v === 10 ? "Медл." : v === 20 ? "Сред." : "Быстр."}
                </button>
              ))}
            </div>
          </div>
          {sheet.isLoading && <Loading />}
          {sheet.error && <ErrorBox error={sheet.error} retry={() => void sheet.refetch()} />}
          {sheet.data && (
            <>
              <div className="muted small tab-meta">
                {sheet.data.artist} — {sheet.data.song}
                {sheet.data.tuning && ` · строй ${sheet.data.tuning}`}
                {sheet.data.capo ? ` · каподастр ${sheet.data.capo}` : ""}
              </div>
              <pre className="tab-sheet" style={{ fontSize: size }}>
                {body}
              </pre>
              <div className="muted small">
                Источник:{" "}
                <a href={sheet.data.url} target="_blank" rel="noopener noreferrer">
                  Ultimate Guitar
                </a>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
