// «Смотреть онлайн» on TV Details: which /online variants it shows (kind
// "online" only — anime stays in the release picker) and the compact
// picker's model. Pure and unit-tested (online.test.ts); the query is in
// onlineQuery.ts.
import type { OnlineList, OnlineVariant } from "./data";

/** The «Смотреть онлайн» variants: provider kind "online" only (server ranking kept). */
export function watchOnlineItems(list: OnlineList | null | undefined): OnlineVariant[] {
  return (list?.items ?? []).filter((v) => v.provider.kind === "online");
}

export interface OnlineSourceGroup {
  id: string;
  name: string;
  /** Preferred voice first, then the server's order. */
  items: OnlineVariant[];
}

/** Variants grouped by source; the group with the preferred / best variant comes first. */
export function groupBySource(items: readonly OnlineVariant[]): OnlineSourceGroup[] {
  const out: OnlineSourceGroup[] = [];
  for (const v of items) {
    let g = out.find((x) => x.id === v.provider.id);
    if (!g) out.push((g = { id: v.provider.id, name: v.provider.name, items: [] }));
    g.items.push(v);
  }
  for (const g of out) g.items.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  return out;
}

const voiceKey = (v: OnlineVariant) => (v.voiceover.studio ?? v.voiceover.kind ?? v.voice).trim().toLowerCase();

/**
 * The variant selected when the picker opens: the server's pick, except on
 * engines without native HLS, which get an MP4 rendition of the same voice
 * when a source offers one (and any MP4 when HLS can't play at all).
 */
export function defaultVariant(items: readonly OnlineVariant[], hls: "native" | "hlsjs" | "none"): OnlineVariant | null {
  const top = items.find((v) => v.preferred) ?? items[0] ?? null;
  if (!top || hls === "native" || top.format === "mp4") return top;
  const sameVoice = items.find((v) => v.format === "mp4" && voiceKey(v) === voiceKey(top));
  if (sameVoice) return sameVoice;
  if (hls === "none") return items.find((v) => v.format === "mp4") ?? top;
  return top;
}

/** Quality chips: null = «Авто» (server: best ≤ the profile's resolution), then best first. */
export function qualityChoices(v: OnlineVariant | null): (number | null)[] {
  const qs = [...new Set(v?.qualities ?? [])].sort((a, b) => b - a);
  return qs.length > 1 ? [null, ...qs] : [];
}

/**
 * Episodes a season-level variant can play that the catalog also knows
 * (playback needs the episode id). Ascending.
 */
export function playableEpisodes(v: OnlineVariant | null, known: readonly number[]): number[] {
  if (!v) return [];
  const have = v.episode != null ? [v.episode] : v.episodes.length > 0 ? v.episodes : [...known];
  return [...new Set(have)].filter((n) => known.includes(n)).sort((a, b) => a - b);
}

/** The episode to start: the wanted one (next up / header) when available, else the nearest after it, else the first. */
export function defaultEpisode(eps: readonly number[], wanted: number | null): number | null {
  if (eps.length === 0) return null;
  if (wanted != null) {
    if (eps.includes(wanted)) return wanted;
    const after = eps.find((n) => n > wanted);
    if (after != null) return after;
  }
  return eps[0]!;
}

/** Picker rows: one voice row per source, then quality, episodes and the play button. */
export type OnlineRow = { kind: "voice"; group: number } | { kind: "quality" } | { kind: "episode" } | { kind: "play" };

export function pickerRows(groups: number, hasQuality: boolean, hasEpisodes: boolean): OnlineRow[] {
  const rows: OnlineRow[] = [];
  for (let g = 0; g < groups; g++) rows.push({ kind: "voice", group: g });
  if (hasQuality) rows.push({ kind: "quality" });
  if (hasEpisodes) rows.push({ kind: "episode" });
  rows.push({ kind: "play" });
  return rows;
}

/** Horizontal scroll of a chip row so the focused chip stays in view (px). */
export function rowScroll(left: number, width: number, viewport: number, current: number, pad = 40): number {
  if (left - current < pad) return Math.max(0, left - pad);
  if (left + width - current > viewport - pad) return left + width - viewport + pad;
  return current;
}

/**
 * The release picker's online group: online and anime variants together
 * (server order), with the kinds present for its title («Онлайн · Аниме»).
 */
export function pickerOnlineGroup(list: OnlineList | null | undefined) {
  const items = (list?.items ?? []).filter((v) => v.provider.kind === "online" || v.provider.kind === "anime");
  const failed = (list?.providers ?? []).filter((p) => (p.kind === "online" || p.kind === "anime") && (p.status === "error" || p.status === "timeout"));
  const kinds = (["online", "anime"] as const).filter((k) => items.some((v) => v.provider.kind === k) || failed.some((p) => p.kind === k));
  return { items, failed, show: items.length > 0 || failed.length > 0, kinds };
}
