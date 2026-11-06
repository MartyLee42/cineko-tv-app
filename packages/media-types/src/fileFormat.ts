// File format of a release for the «Раздачи» lists (MKV, AVI, MP4…). Only the
// title is known before the torrent is added, so this reads explicit hints
// («.mkv», «[AVI]», «BDMV»), XviD/DivX (= AVI in practice) and the old-style
// rip that names neither codec nor resolution (most likely an XviD AVI: shown
// as «AVI?»). Nothing is guessed for modern H.264/HEVC rips.

export interface ReleaseFormat {
  label: string;
  /** A guess (shown with «?»). */
  guess: boolean;
}

const EXPLICIT: [RegExp, string][] = [
  [/\b(?:BDMV|Blu-?ray\s*(?:Disc|BD-?(?:25|50|66|100))|BD-?(?:25|50|66|100)|COMPLETE\s*BLURAY)\b/i, "Blu-ray"],
  [/\b(?:VIDEO_TS|DVD-?[59]|DVD\s*Video)\b/i, "DVD"],
  [/(?:\.iso\b|\bISO\b)/i, "ISO"],
  [/(?:\.m2ts\b|\bM2TS\b)/i, "M2TS"],
  [/(?:\.mkv\b|\bMKV\b)/i, "MKV"],
  [/(?:\.avi\b|\bAVI\b)/i, "AVI"],
  [/(?:\.(?:mp4|m4v)\b|\bMP4\b)/i, "MP4"],
  [/(?:\.webm\b|\bWebM\b)/i, "WebM"],
  [/(?:\.wmv\b|\bWMV\b)/i, "WMV"],
  [/(?:\.ts\b)/i, "TS"],
];

export function releaseFormat(r: { title: string; video_codec?: string | null; resolution?: string | null; source_quality?: string | null }): ReleaseFormat | null {
  for (const [re, label] of EXPLICIT) if (re.test(r.title)) return { label, guess: false };
  const vc = (r.video_codec ?? "").toLowerCase();
  if (vc === "xvid" || vc === "divx" || vc === "mpeg4") return { label: "AVI", guess: false };
  if (!vc && !r.resolution && ["bdrip", "webrip", "hdtv", "dvd"].includes(r.source_quality ?? "")) return { label: "AVI", guess: true };
  return null;
}

export function releaseFormatText(f: ReleaseFormat | null): string | null {
  return f ? `${f.label}${f.guess ? "?" : ""}` : null;
}
