import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "@martytv/ui";
import { capsFromAuto, fitChipShort, fitChipText, fitContainerKey, fitCoveredWarnings, fitHeadline, fitInput, judgeFit, type DeviceCaps } from "@martytv/media-types";

const ru = (k: string, v?: Record<string, string | number>) => translate("ru", k as MessageKey, v);
const texts = (f: ReturnType<typeof judgeFit>) => f.chips.map((c) => fitChipText(c, ru));

/** A 1080p Android TV box: H.264/HEVC, AAC/AC3, MKV/MP4, server compat audio. */
const BOX: DeviceCaps = capsFromAuto(
  { video: ["h264", "hevc"], audio: ["aac", "ac3"], containers: ["mkv", "mp4"], hls: true, compat: true, screen_width: 1920, screen_height: 1080 },
  "Living Room",
);

const rel = (o: Record<string, unknown> = {}) => ({ title: "Film (2024) BDRip 1080p", video_codec: "h264", audio_codecs: ["ac3"], resolution: "1080p", hdr: null, warnings: [], ...o });

describe("judgeFit", () => {
  it("plays: names the device", () => {
    const f = judgeFit(fitInput(rel()), BOX);
    expect(f.verdict).toBe("ok");
    expect(texts(f)).toEqual(["✓ Пойдёт на Living Room"]);
  });

  it("audio the TV can't decode: the server converts it when compat is available", () => {
    const f = judgeFit(fitInput(rel({ audio_codecs: ["dts"] })), BOX);
    expect(f.verdict).toBe("convert");
    expect(texts(f)).toEqual(["✓ Пойдёт на Living Room", "Звук DTS → сервер переведёт в AAC"]);
    const noCompat = judgeFit(fitInput(rel({ audio_codecs: ["dts"] })), { ...BOX, compat: false });
    expect(noCompat.verdict).toBe("bad");
    expect(texts(noCompat)).toEqual(["✗ Звук DTS не поддерживается"]);
  });

  it("title codecs: one decodable listed track is enough; a prepared source's default track decides", () => {
    expect(judgeFit(fitInput(rel({ audio_codecs: ["dts", "ac3"] })), { ...BOX, compat: false }).verdict).toBe("ok");
    const src = { media_info: { container: "matroska,webm", video_codec: "h264", audio: [{ codec: "ac3", default: false }, { codec: "truehd", default: true }] } };
    const f = judgeFit(fitInput(rel({ audio_codecs: ["ac3", "truehd"] }), src), { ...BOX, compat: false });
    expect(texts(f)).toEqual(["✗ Звук TrueHD не поддерживается"]);
  });

  it("unsupported video, a 4K release on a 1080p screen (informational)", () => {
    const f = judgeFit(fitInput(rel({ video_codec: "hevc", resolution: "2160p" })), { ...BOX, video: ["h264"] });
    expect(f.verdict).toBe("bad");
    expect(texts(f)).toEqual(["✗ Видео HEVC не поддерживается", "4K: экран 1080p"]);
    const ok4k = judgeFit(fitInput(rel({ video_codec: "hevc", resolution: "2160p" })), BOX);
    expect(ok4k.verdict).toBe("ok");
    expect(texts(ok4k)).toEqual(["✓ Пойдёт на Living Room", "4K: экран 1080p"]);
  });

  it("AVI / XviD: the server converts it with compat, else may not play", () => {
    const xvid = rel({ title: "Film.2004.DVDRip.XviD.avi", video_codec: "xvid", audio_codecs: ["ac3"], resolution: "480p" });
    const f = judgeFit(fitInput(xvid), BOX);
    expect(f.verdict).toBe("convert");
    expect(texts(f)).toEqual(["✓ Пойдёт на Living Room", "Видео XviD → сервер перекодирует в H.264"]);
    expect(fitHeadline(f)).toEqual({ code: "video_convert", tone: "convert", codec: "XviD" });
    expect(fitChipShort(fitHeadline(f)!)).toBe("XviD→H.264");
    // A prepared source: ffprobe's mpeg4 in AVI, AC3 → AAC too (video first).
    const src = { media_info: { container: "avi", video_codec: "mpeg4", audio: [{ codec: "dts", default: true }] } };
    expect(texts(judgeFit(fitInput(xvid, src), BOX))).toEqual(["✓ Пойдёт на Living Room", "Видео XviD → сервер перекодирует в H.264", "Звук DTS → сервер переведёт в AAC"]);
    // MPEG-2 at 1080p converts; above 1080p the server won't.
    expect(judgeFit(fitInput(rel({ video_codec: "mpeg2", audio_codecs: ["ac3"], resolution: "1080p" })), BOX).verdict).toBe("convert");
    expect(judgeFit(fitInput(rel({ video_codec: "mpeg2", audio_codecs: ["ac3"], resolution: "2160p" })), BOX).verdict).toBe("maybe");
    // H.264 in AVI: only the container is repackaged.
    const avi = judgeFit(fitInput(rel({ title: "Film.2004.avi", video_codec: "h264", audio_codecs: ["aac"] })), BOX);
    expect(avi.verdict).toBe("convert");
    expect(texts(avi)).toEqual(["✓ Пойдёт на Living Room", "AVI → сервер перепакует в MP4"]);
    // Without compat: may not play.
    const noCompat = judgeFit(fitInput(xvid), { ...BOX, compat: false });
    expect(noCompat.verdict).toBe("maybe");
    expect(texts(noCompat)).toEqual(["Может не заиграть: AVI/XviD"]);
  });

  it("known containers: «MKV ✓» last, unsupported ones fail", () => {
    const src = { mime_type: "video/x-matroska", media_info: null };
    expect(texts(judgeFit(fitInput(rel(), src), BOX))).toEqual(["✓ Пойдёт на Living Room", "MKV ✓"]);
    expect(texts(judgeFit(fitInput(rel(), src), { ...BOX, containers: ["mp4"] }))).toEqual(["✗ MKV не поддерживается"]);
  });

  it("at most 3 chips, failures first", () => {
    const f = judgeFit(fitInput(rel({ video_codec: "hevc", audio_codecs: ["dts"], resolution: "2160p", hdr: "hdr10" })), { ...BOX, video: ["h264"], compat: false });
    expect(texts(f)).toEqual(["✗ Видео HEVC не поддерживается", "✗ Звук DTS не поддерживается", "4K: экран 1080p"]);
  });

  it("nothing reported: unknown, no verdict chips (never «unsupported»)", () => {
    const f = judgeFit(fitInput(rel({ video_codec: "hevc", audio_codecs: ["dts"] })), capsFromAuto({}, "TV"));
    expect(f).toEqual({ verdict: "unknown", chips: [] });
    expect(judgeFit(fitInput(rel({ video_codec: null, audio_codecs: [] })), BOX).verdict).toBe("unknown");
  });

  it("H.264 10-bit: doubtful unless the device reports 10-bit profiles", () => {
    const r = rel({ title: "Anime 1080p Hi10P", video_codec: "h264", audio_codecs: ["aac"] });
    expect(texts(judgeFit(fitInput(r), BOX))).toEqual(["Может не заиграть: H.264 10-bit"]);
    expect(judgeFit(fitInput(r), { ...BOX, video: ["h264", "hevc", "hevc_10bit"] }).verdict).toBe("bad");
    expect(judgeFit(fitInput(r), { ...BOX, video: ["h264", "h264_10bit"] }).verdict).toBe("ok");
  });

  it("online (HLS) variants and disc images", () => {
    const online = { ...rel({ video_codec: null, audio_codecs: [] }), provider: { kind: "online" } };
    expect(texts(judgeFit(fitInput(online), BOX))).toEqual(["✓ Пойдёт на Living Room"]);
    expect(texts(judgeFit(fitInput(online), { ...BOX, hls: false }))).toEqual(["✗ Онлайн-поток (HLS) не поддерживается"]);
    expect(judgeFit(fitInput(rel({ warnings: ["disc_image"] })), BOX).verdict).toBe("bad");
  });

  it("covered server warnings", () => {
    expect(fitCoveredWarnings(judgeFit(fitInput(rel()), BOX))).toContain("audio_needs_conversion");
    expect(fitCoveredWarnings({ verdict: "unknown", chips: [] })).toEqual([]);
  });
});

describe("fitContainerKey", () => {
  it("ffprobe names, MIME types, file names", () => {
    expect(fitContainerKey("matroska,webm")).toBe("mkv");
    expect(fitContainerKey("mov,mp4,m4a,3gp,3g2,mj2")).toBe("mp4");
    expect(fitContainerKey("video/mp2t")).toBe("ts");
    expect(fitContainerKey("Film/Film.2004.avi")).toBe("avi");
    expect(fitContainerKey(null)).toBe(null);
  });
});
