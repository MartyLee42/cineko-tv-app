// "Choose a source" for one track: tabs Все / Zaycev / YouTube / Торренты.
// Zaycev and YouTube load in parallel as the dialog opens (one request
// each, a spinner / error per tab); the trackers (slow, up to ~40 s) are
// searched when their tab is opened.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, fmtTime, type Candidate, type Me, type Track, type ZvCandidate } from "./api";
import { ModalHead, ReleasePicker, TrackFilePicker, openModal, releaseSearch } from "./dialogs";
import { PlayIcon } from "./icons";
import { usePlayer } from "./player";
import {
  allPreview,
  canSave,
  currentSource,
  itemTrack,
  providersFor,
  sourceQuery,
  sourceTabs,
  torrentQuery,
  youtubeItems,
  zaycevItems,
  PROVIDER_LABEL,
  type ProviderState,
  type SourceItem,
  type SourceTab,
  type SourcesReply,
} from "./sources";
import { toast } from "./toast";

export function openSourcePicker(t: Track, tab: SourceTab = "all") {
  openModal((close) => <SourceDialog track={t} initial={tab} close={close} />);
}

function status(q: { isLoading: boolean; error: unknown; data?: unknown; fetchStatus: string }, count: number): ProviderState {
  if (q.isLoading && q.fetchStatus !== "idle") return { status: "loading", count: 0 };
  if (q.error) return { status: "error", count: 0 };
  if (q.data !== undefined) return { status: "ok", count };
  return { status: "idle", count: 0 };
}

function SourceDialog({ track, initial, close }: { track: Track; initial: SourceTab; close: () => void }) {
  const player = usePlayer();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
  const providers = providersFor(track, me.data?.features);
  const [tab, setTab] = useState<SourceTab>(initial);
  const [torrentsOn, setTorrentsOn] = useState(initial === "torrents");
  const [hash, setHash] = useState<string | null>(null);
  const qs = sourceQuery(track);
  const opts = { staleTime: 5 * 60_000, retry: false } as const;
  const yt = useQuery({
    queryKey: ["sources", "youtube", qs],
    queryFn: () => api.get<SourcesReply<Candidate>>(`/sources/youtube?${qs}`),
    enabled: providers.includes("youtube"),
    ...opts,
  });
  const zv = useQuery({
    queryKey: ["sources", "zaycev", qs],
    queryFn: () => api.get<SourcesReply<ZvCandidate>>(`/sources/zaycev?${qs}`),
    enabled: providers.includes("zaycev"),
    ...opts,
  });
  const tq = torrentQuery(track);
  const rel = useQuery({ ...releaseSearch(tq), enabled: torrentsOn && providers.includes("torrents") });
  useEffect(() => {
    if (tab === "torrents") setTorrentsOn(true);
  }, [tab]);

  const reply = zv.data ?? yt.data;
  const cur = currentSource(track, reply?.current ?? "", reply?.torrent);
  const curValue = cur?.value ?? null;
  const groups = {
    zaycev: zv.data ? zaycevItems(zv.data.items, curValue) : [],
    youtube: yt.data ? youtubeItems(yt.data.items, curValue) : [],
  };
  const tabs = sourceTabs(
    providers,
    { zaycev: status(zv, groups.zaycev.length), youtube: status(yt, groups.youtube.length), torrents: status(rel, rel.data?.length ?? 0) },
    cur?.provider ?? null,
  );
  const saved = canSave(track);

  // Preview in a throwaway element (the player pauses meanwhile).
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!preview) return;
    const a = new Audio(preview.startsWith("zv:") ? `/music/api/zv/${preview.slice(3)}` : `/music/api/yt/${preview}?preview=1`);
    if (player.playing) player.pause();
    a.play().catch(() => toast("Не удалось воспроизвести"));
    return () => {
      a.pause();
      a.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  const choose = async (it: SourceItem) => {
    setPreview(null);
    if (!saved) {
      // A plain upload / torrent file: nothing to remember, just play the choice.
      player.playList([itemTrack(track, it)], 0, { type: "other", name: track.title });
      close();
      return;
    }
    try {
      await api.put("/sources/match", { trackId: track.id, artist: track.artist, title: track.title, value: it.value });
      toast(`Запись заменена · ${PROVIDER_LABEL[it.provider]}`);
      void qc.invalidateQueries({ queryKey: ["sources"] });
      close();
      if (player.current?.id === track.id) player.reloadCurrent();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const rows = (items: SourceItem[]) => (
    <div className="cand-list">
      {items.map((c) => (
        <CandRow key={`${c.provider}:${c.value}`} item={c} track={track} previewing={preview === c.value}
          onPreview={() => setPreview(preview === c.value ? null : c.value)} onChoose={() => void choose(c)} />
      ))}
    </div>
  );
  const state = (q: { isLoading: boolean; error: unknown; fetchStatus: string }, empty: boolean, what: string) =>
    q.isLoading && q.fetchStatus !== "idle" ? (
      <div className="searching"><span className="spinner" /> Ищем на {what}…</div>
    ) : q.error ? (
      <p className="error-text">{(q.error as Error).message}</p>
    ) : empty ? (
      <p className="muted small">Ничего не нашли.</p>
    ) : null;

  const provQ = { zaycev: zv, youtube: yt } as const;
  const where = { zaycev: "Zaycev.net", youtube: "YouTube" } as const;

  return (
    <>
      <ModalHead title="Источник звука" close={close} />
      <p className="muted small">
        {track.artist} — {track.title}
        {track.duration ? ` · ${fmtTime(track.duration)}` : ""}.{" "}
        {saved
          ? "Если играет не та версия (концерт, кавер), выберите другую — выбор запомнится."
          : "Выбранная запись сыграет сразу (для этого трека выбор не запоминается)."}
      </p>
      <div className="chips src-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`chip ${tab === t.id ? "on" : ""} ${t.current ? "is-current" : ""}`}
            onClick={() => setTab(t.id)} title={t.current ? "Сейчас играет отсюда" : undefined}>
            {t.current && <span className="src-dot" aria-label="сейчас" />}
            {t.label}
            {t.loading ? <span className="spinner inline" /> : t.error ? <span className="src-err">!</span> : t.count !== null ? <span className="src-count">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {tab === "all" && (
        <>
          {(["zaycev", "youtube"] as const)
            .filter((p) => providers.includes(p))
            .map((p) => {
              const items = allPreview({ [p]: groups[p] });
              const more = groups[p].length - items.length;
              return (
                <section key={p}>
                  <h4 className="cand-head src-head">
                    {where[p]}
                    {more > 0 && (
                      <button className="link small" onClick={() => setTab(p)}>
                        ещё {more} ›
                      </button>
                    )}
                  </h4>
                  {state(provQ[p], groups[p].length === 0, where[p])}
                  {rows(items)}
                </section>
              );
            })}
          {providers.includes("torrents") && (
            <section>
              <h4 className="cand-head src-head">Торренты · MP3 / FLAC</h4>
              {cur?.provider === "torrents" && <p className="muted small">Сейчас играет из раздачи.</p>}
              <button className="btn ghost small" onClick={() => setTab("torrents")}>
                {rel.data ? `Раздачи: ${rel.data.length} ›` : "Искать на трекерах ›"}
              </button>
            </section>
          )}
        </>
      )}

      {(tab === "zaycev" || tab === "youtube") && (
        <>
          {state(provQ[tab], groups[tab].length === 0, where[tab])}
          {rows(groups[tab])}
        </>
      )}

      {tab === "torrents" &&
        (hash ? (
          <TrackFilePicker track={track} hash={hash} onBack={() => setHash(null)} close={close} />
        ) : (
          <ReleasePicker {...tq} onOpened={setHash} />
        ))}
    </>
  );
}

function CandRow({ item, track, previewing, onPreview, onChoose }: {
  item: SourceItem;
  track: Track;
  previewing: boolean;
  onPreview: () => void;
  onChoose: () => void;
}) {
  return (
    <div className={`cand ${item.current ? "current" : ""}`}>
      <button className="icon-btn" title="Прослушать" onClick={onPreview}>
        {previewing ? "■" : <PlayIcon size={16} />}
      </button>
      <div className="cand-text">
        <div className="cand-title">{item.title}</div>
        <div className="muted small">
          {item.sub} · {fmtTime(item.duration)}
          {track.duration > 0 && Math.abs(item.duration - track.duration) > 10 && <span className="warn"> · длина отличается</span>}
        </div>
      </div>
      {item.current ? (
        <span className="chip">Сейчас</span>
      ) : (
        <button className="btn small" onClick={onChoose}>
          Выбрать
        </button>
      )}
    </div>
  );
}
