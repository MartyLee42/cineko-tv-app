// «Смотреть онлайн»: a compact modal over Details. One row of voice-over
// chips per source (preferred first), quality, episodes (series) and Play.
// ▲▼ move between rows, ◀▶ along a row, OK picks a chip (focus returns to
// Play) or plays, Play key plays at once, Back closes. Handles its own keys
// over Details (like ActionMenu).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { hasMediaSource, hlsMode } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { claimKeys } from "../remote/keyOwner";
import { useDesign } from "../design/context";
import { engineProbe } from "./codecs";
import { playerKey } from "./keys";
import type { OnlineVariant } from "./data";
import { defaultEpisode, defaultVariant, groupBySource, pickerRows, playableEpisodes, qualityChoices, rowScroll } from "./online";

/** Focus row meaning "the Play button" (rows are clamped to the last one, which is Play). */
const PLAY_ROW = 999;
/** Width of a chip row's viewport (the panel minus its padding and row label). */
const ROW_VIEW = 1100;

export interface OnlineChoice {
  variant: OnlineVariant;
  /** null = «Авто». */
  quality: number | null;
  /** Series: the episode number in `season`. */
  episode: number | null;
}

export function OnlinePicker({
  title,
  season,
  items,
  knownEpisodes,
  wantedEpisode,
  onPlay,
  onClose,
}: {
  title: string;
  /** Series: the season the variants are for (null = movie). */
  season: number | null;
  /** Online variants (kind "online"), server-ranked. */
  items: OnlineVariant[];
  /** Episode numbers of `season` the catalog knows. */
  knownEpisodes: number[];
  /** The next-up / header episode. */
  wantedEpisode: number | null;
  onPlay: (c: OnlineChoice) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const square = useDesign() === "terminal";
  const groups = useMemo(() => groupBySource(items), [items]);
  const series = season !== null;
  const hls = useMemo(() => {
    const p = engineProbe();
    return hlsMode(p, hasMediaSource());
  }, []);

  const [sel, setSel] = useState<OnlineVariant | null>(() => defaultVariant(items, hls));
  const [quality, setQuality] = useState<number | null>(null);
  const eps = useMemo(() => (series ? playableEpisodes(sel, knownEpisodes) : []), [series, sel, knownEpisodes]);
  const [episode, setEpisode] = useState<number | null>(() => (series ? defaultEpisode(playableEpisodes(sel, knownEpisodes), wantedEpisode) : null));
  const qualities = qualityChoices(sel);
  const rows = pickerRows(groups.length, qualities.length > 0, series && eps.length > 0);
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: PLAY_ROW, col: 0 });
  const row = rows[Math.min(focus.row, rows.length - 1)]!;

  /** Chips of a row (count), and the column of the current selection in it. */
  const rowLength = (r: (typeof rows)[number]): number =>
    r.kind === "voice" ? groups[r.group]!.items.length : r.kind === "quality" ? qualities.length : r.kind === "episode" ? eps.length : 1;
  const selectedCol = (r: (typeof rows)[number]): number => {
    if (r.kind === "voice") return Math.max(0, groups[r.group]!.items.findIndex((v) => v.id === sel?.id));
    if (r.kind === "quality") return Math.max(0, qualities.indexOf(quality));
    if (r.kind === "episode") return Math.max(0, eps.indexOf(episode ?? -1));
    return 0;
  };

  const choose = (v: OnlineVariant) => {
    setSel(v);
    if (quality !== null && !v.qualities.includes(quality)) setQuality(null);
    if (series) {
      const next = playableEpisodes(v, knownEpisodes);
      if (episode === null || !next.includes(episode)) setEpisode(defaultEpisode(next, episode ?? wantedEpisode));
    }
  };
  const play = (v = sel, q = quality, e = episode) => {
    if (!v || (series && e === null)) return;
    onPlay({ variant: v, quality: q !== null && v.qualities.includes(q) ? q : null, episode: series ? e : null });
  };

  // Keys: refs keep the handler (registered once) current.
  const st = useRef({ rows, row, focus, rowLength, selectedCol, choose, play, onClose, groups, qualities, eps });
  useEffect(() => {
    st.current = { rows, row, focus, rowLength, selectedCol, choose, play, onClose, groups, qualities, eps };
  });
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const s = st.current;
      const at = Math.min(s.focus.row, s.rows.length - 1);
      const r = s.rows[at]!;
      /** Selects the focused chip. */
      const apply = () => {
        if (r.kind === "voice") {
          const v = s.groups[r.group]!.items[s.focus.col];
          if (v) s.choose(v);
        } else if (r.kind === "quality") setQuality(s.qualities[s.focus.col] ?? null);
        else if (r.kind === "episode") setEpisode(s.eps[s.focus.col] ?? null);
      };
      const toRow = (i: number) => setFocus({ row: i, col: s.selectedCol(s.rows[i]!) });
      if (k === "up") {
        if (at > 0) toRow(at - 1);
      } else if (k === "down") {
        if (at < s.rows.length - 1) toRow(at + 1);
      } else if (k === "left") {
        setFocus({ row: at, col: Math.max(0, s.focus.col - 1) });
      } else if (k === "right") {
        setFocus({ row: at, col: Math.min(s.rowLength(r) - 1, s.focus.col + 1) });
      } else if (k === "ok") {
        if (e.repeat) return;
        if (r.kind === "play") return s.play();
        apply();
        // Picked: back to Play (one more OK starts it; rows may change with the pick).
        setFocus({ row: PLAY_ROW, col: 0 });
      } else if (k === "play" || k === "playpause") {
        if (r.kind === "voice") {
          const v = s.groups[r.group]!.items[s.focus.col];
          if (v) return s.play(v);
        } else if (r.kind === "quality") return s.play(undefined, s.qualities[s.focus.col] ?? null);
        else if (r.kind === "episode") return s.play(undefined, undefined, s.eps[s.focus.col] ?? null);
        s.play();
      } else if (k === "back" || k === "stop") s.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, []);

  // Horizontal scroll of the focused row.
  const tracks = useRef(new Map<string, HTMLDivElement>());
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const rowId = (r: (typeof rows)[number]) => (r.kind === "voice" ? `voice-${r.group}` : r.kind);
  const focusedRowId = rowId(row);
  useLayoutEffect(() => {
    const track = tracks.current.get(focusedRowId);
    const chip = track?.children[focus.col] as HTMLElement | undefined;
    if (!chip) return;
    setOffsets((o) => {
      const cur = o[focusedRowId] ?? 0;
      const next = rowScroll(chip.offsetLeft, chip.offsetWidth, ROW_VIEW, cur);
      return next === cur ? o : { ...o, [focusedRowId]: next };
    });
  }, [focusedRowId, focus.col]);

  const shape = square ? "t-label" : "rounded-control";
  const chip = (selected: boolean, focused: boolean) =>
    `tv-focus tv-chip mr-4 flex h-[64px] shrink-0 items-center whitespace-nowrap px-7 text-[26px] font-semibold ${shape} ${
      focused ? "is-focused" : selected ? "bg-accent text-on-accent" : "bg-surface-2 text-text"
    }`;
  const chipRow = (r: (typeof rows)[number], label: string, chips: { key: string; text: string; selected: boolean; attrs: Record<string, string> }[], testId: string) => {
    const id = rowId(r);
    const focusedHere = rowId(row) === id;
    return (
      <div key={id} data-testid={testId} className="mt-7 flex items-center">
        <p className="w-[320px] shrink-0 truncate pr-6 text-[24px] text-muted">{label}</p>
        <div className="overflow-hidden py-4" style={{ width: ROW_VIEW }}>
          <div
            ref={(el) => {
              if (el) tracks.current.set(id, el);
              else tracks.current.delete(id);
            }}
            className="tv-track flex"
            style={{ transform: `translate3d(${-(offsets[id] ?? 0)}px,0,0)`, paddingLeft: 12 }}
          >
            {chips.map((c, i) => (
              <div key={c.key} {...c.attrs} data-selected={c.selected ? "1" : undefined} className={chip(c.selected, focusedHere && focus.col === i)}>
                {c.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div data-testid="online-picker" className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] items-center justify-center bg-black/70">
      <div className={`w-[1560px] bg-surface px-16 py-12 shadow-2xl ${square ? "" : "rounded-card"}`}>
        <p className="text-[24px] font-bold uppercase tracking-[.14em] text-accent">{t("online.picker.title")}</p>
        <h2 className="mt-2 truncate text-[48px] font-bold leading-tight">
          {title}
          {series && season !== null ? <span className="ml-5 text-[32px] font-medium text-muted">{t("online.picker.season", { n: season })}</span> : null}
        </h2>
        {rows.map((r) => {
          if (r.kind === "voice") {
            const g = groups[r.group]!;
            const format = [...new Set(g.items.map((v) => v.format.toUpperCase()))].join("/");
            return chipRow(
              r,
              `${g.name} · ${format}`,
              g.items.map((v) => ({
                key: v.id,
                text: `${v.preferred ? "★ " : ""}${v.voice}${v.max_quality ? ` · ${v.max_quality}p` : ""}`,
                selected: v.id === sel?.id,
                attrs: { "data-variant-id": v.id, "data-provider": g.id },
              })),
              `online-voices-${g.id}`,
            );
          }
          if (r.kind === "quality")
            return chipRow(
              r,
              t("online.picker.quality"),
              qualities.map((q) => ({ key: String(q), text: q === null ? t("online.picker.quality_auto") : `${q}p`, selected: q === quality, attrs: { "data-quality": q === null ? "auto" : String(q) } })),
              "online-quality",
            );
          if (r.kind === "episode")
            return chipRow(
              r,
              t("online.picker.episodes"),
              eps.map((n) => ({ key: String(n), text: String(n), selected: n === episode, attrs: { "data-episode": String(n) } })),
              "online-episodes",
            );
          const focused = row.kind === "play";
          return (
            <div key="play" className="mt-10 flex items-center">
              <div
                data-testid="online-play"
                className={`tv-focus flex h-[80px] items-center px-12 text-[30px] font-bold ${shape} ${focused ? "is-focused bg-accent text-on-accent" : "bg-surface-2 text-text"}`}
              >
                <span className="mr-4 text-[24px]">▶</span>
                {series && episode !== null ? `${t("online.picker.play")} · ${t("online.picker.episode", { n: episode })}` : t("online.picker.play")}
              </div>
              {sel && (
                <p data-testid="online-selection" className="ml-8 truncate text-[24px] text-muted">
                  {[sel.provider.name, sel.voice, quality ? `${quality}p` : t("online.picker.quality_auto"), sel.format.toUpperCase()].join(" · ")}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
