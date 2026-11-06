import { describe, expect, it } from "vitest";
import { releaseFormat, releaseFormatText } from "@martytv/media-types";

const f = (title: string, o: Record<string, string | null> = {}) => releaseFormatText(releaseFormat({ title, ...o }));

describe("releaseFormat", () => {
  it("reads explicit hints", () => {
    expect(f("Movie.2010.1080p.BluRay.x264.mkv", { video_codec: "h264", resolution: "1080p" })).toBe("MKV");
    expect(f("Фильм (2010) BDRip [AVI]")).toBe("AVI");
    expect(f("Movie 2010 COMPLETE BLURAY BDMV")).toBe("Blu-ray");
    expect(f("Фильм (1999) DVD9 VIDEO_TS")).toBe("DVD");
    expect(f("Movie.2010.WEBRip.720p.mp4", { resolution: "720p" })).toBe("MP4");
  });
  it("XviD / DivX is AVI; the bare old-style rip is a guess", () => {
    expect(f("Фильм (2004) DVDRip XviD", { video_codec: "xvid", source_quality: "dvd" })).toBe("AVI");
    expect(f("Последняя дуэль / The Last Duel (2021) BDRip", { source_quality: "bdrip" })).toBe("AVI?");
  });
  it("doesn't guess for modern rips", () => {
    expect(f("Фильм (2021) BDRip 1080p", { resolution: "1080p", source_quality: "bdrip" })).toBe(null);
    expect(f("Фильм (2021) WEB-DL HEVC", { video_codec: "hevc", source_quality: "web-dl" })).toBe(null);
  });
});
