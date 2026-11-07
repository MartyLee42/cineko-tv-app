// «Плавность»: video variants a device decodes but not smoothly (its
// navigator.mediaCapabilities.decodingInfo says smooth = false, or playback
// dropped many frames there). A token is `<codec>[_10bit]_<1080p|2160p>`;
// the device reports them as PlaybackAuto.rough and the server's ranking
// demotes matching releases (services/api devicefit.go smoothToken — keep
// the two mappings identical). Lower resolutions and other codecs aren't judged.

export const SMOOTH_TOKENS = [
  "h264_1080p",
  "h264_2160p",
  "hevc_1080p",
  "hevc_2160p",
  "hevc_10bit_1080p",
  "hevc_10bit_2160p",
  "av1_1080p",
  "av1_2160p",
  "av1_10bit_1080p",
  "av1_10bit_2160p",
] as const;
export type SmoothToken = (typeof SMOOTH_TOKENS)[number];

const TEN_BIT = /(?:^|[^0-9])10[- ]?bit|\bHi10P?\b/i;

/** "2160p" / "1080p" class of a resolution label or a frame size; null below 1080p or unknown. */
export function smoothClass(res: string | null | undefined, width?: number | null, height?: number | null): "1080p" | "2160p" | null {
  if (res === "2160p") return "2160p";
  if (res === "1080p") return "1080p";
  if (res) return null;
  // Frame size (cropped scope films: 1920×800 is still 1080p).
  const w = width ?? 0;
  const h = height ?? 0;
  if (w >= 3000 || h >= 1600) return "2160p";
  if (w >= 1700 || h >= 1000) return "1080p";
  return null;
}

/** The token for a codec ("h264", "hevc", "av1"), bit depth and size class; null when not judged. */
export function smoothToken(codec: string | null | undefined, tenBit: boolean, cls: "1080p" | "2160p" | null): SmoothToken | null {
  if (!cls) return null;
  const c = (codec ?? "").toLowerCase();
  if (c !== "h264" && c !== "hevc" && c !== "av1") return null;
  // 10-bit H.264 is a decodability question (codecs.ts), not smoothness.
  if (c === "h264" && tenBit) return null;
  return `${c}${tenBit ? "_10bit" : ""}_${cls}` as SmoothToken;
}

/** A parsed release's token: codec, 10-bit from HDR or the title («10bit», «Hi10P»), resolution. */
export function releaseSmoothToken(r: { video_codec?: string | null; resolution?: string | null; hdr?: string | null; title?: string | null }): SmoothToken | null {
  const tenBit = !!r.hdr || TEN_BIT.test(r.title ?? "");
  return smoothToken(r.video_codec, tenBit, smoothClass(r.resolution ?? null));
}
