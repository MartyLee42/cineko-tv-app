// Pure helpers for ticket stubs and achievement stickers (TV «Моё», PWA «Билеты»).
import type { MessageKey } from "../i18n";
import { pluralForm } from "../deviceHealth";
import { STICKERS, type StickerId } from "./stickers";

/** Holes on a stub: one per rating point. */
export const HOLES = 10;

/** The stub's punch card: `rating` holes punched from the first; none when unrated. */
export function punchHoles(rating: number | null | undefined): boolean[] {
  const n = rating == null || !Number.isFinite(rating) ? 0 : Math.max(0, Math.min(HOLES, Math.round(rating)));
  const out: boolean[] = [];
  for (let i = 0; i < HOLES; i++) out.push(i < n);
  return out;
}

/** 42 → "000042" (the stub's serial). */
export function ticketSerial(n: number): string {
  const s = String(Math.max(0, Math.floor(n)));
  return s.length >= 6 ? s : "000000".slice(s.length) + s;
}

/** "2026-11-07" → "07.11.2026" (stubs print numeric dates in every language). */
export function ticketDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Paper colours of the ticket rolls; a stub's roll follows its number. */
export const PAPERS = ["cream", "rose", "mint", "sky", "butter"] as const;
export type Paper = (typeof PAPERS)[number];

/** Rolls change every few stubs, like a box office running out of one colour. */
export function paperFor(number: number): Paper {
  return PAPERS[Math.floor(Math.max(0, number - 1) / 3) % PAPERS.length]!;
}

/** A stub pinned to the wall sits a little crooked: −2°…+2°, stable per number. */
export function tiltFor(number: number): number {
  const x = Math.sin(number * 12.9898) * 43758.5453;
  const f = x - Math.floor(x);
  return Math.round((f * 4 - 2) * 10) / 10;
}


export { STICKERS, type StickerId };

export function isSticker(id: string): id is StickerId {
  return (STICKERS as readonly string[]).indexOf(id) >= 0;
}

/** Name and description keys of a sticker. */
export function stickerKeys(id: StickerId): { name: MessageKey; desc: MessageKey } {
  return { name: `keepsakes.ach.${id}` as MessageKey, desc: `keepsakes.ach.${id}.desc` as MessageKey };
}

/** A sticker's slant on the page (stable per id). */
export function stickerTilt(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 13) - 6;
}

/** «Ещё 2 наклейки — секрет» key for n hidden stickers (null when none). */
export function secretKey(locale: string, n: number): MessageKey | null {
  if (n <= 0) return null;
  return `keepsakes.secret_${pluralForm(locale, n)}` as MessageKey;
}

/** «12 билетов». */
export function countKey(locale: string, n: number): MessageKey {
  return `keepsakes.count_${pluralForm(locale, n)}` as MessageKey;
}

/** Only stickers the client can draw, in the API's (unlock) order. */
export function knownStickers<T extends { id: string }>(items: readonly T[]): (T & { id: StickerId })[] {
  return items.filter((a): a is T & { id: StickerId } => isSticker(a.id));
}

/** A progress bar's fill, 0…1 («37 / 50»). */
export function progressShare(have: number, need: number): number {
  if (!(need > 0) || !Number.isFinite(have)) return 0;
  return Math.max(0, Math.min(1, have / need));
}

/** «37 / 50» (thousands split by a thin space: «740 / 1 000»). */
export function progressLabel(have: number, need: number): string {
  const n = (x: number) => String(Math.max(0, Math.floor(x))).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
  return `${n(have)} / ${n(need)}`;
}
