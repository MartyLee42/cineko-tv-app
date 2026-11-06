import { describe, expect, it } from "vitest";
import { chooseQuality, expiryOf, ladderOf, movieVoices, parsePlaylist, parseVideo, pickVoice, seriesIndex, voiceOf } from "./cvh";
import playlistMovie from "./testdata/playlist_301.json";
import playlistSeries from "./testdata/playlist_77044.json";
import video from "./testdata/video_301.json";
import { neighbour } from "../shared/source";

describe("parsePlaylist", () => {
  it("normalises ids and drops empty uploads", () => {
    const pl = parsePlaylist({ titleName: " X ", isSerial: true, items: [{ vkId: 123, season: 1, episode: 2 }, { vkId: "0" }, { vkId: "" }, null] });
    expect(pl.title).toBe("X");
    expect(pl.isSerial).toBe(true);
    expect(pl.items).toEqual([{ vkId: "123", season: 1, episode: 2 }]);
  });
  it("survives garbage", () => {
    expect(parsePlaylist(null)).toEqual({ title: "", isSerial: false, items: [] });
    expect(parsePlaylist({ items: "nope" }).items).toEqual([]);
  });
});

describe("voices", () => {
  it("labels by studio, else by the generic voice type", () => {
    expect(voiceOf({ vkId: "1", voiceType: "Дубляж" })).toEqual({ label: "Дубляж", kind: "dub" });
    expect(voiceOf({ vkId: "1", voiceStudio: "SDI Media", voiceType: "Многоголосый" })).toEqual({ label: "SDI Media", kind: "mvo" });
    expect(voiceOf({ vkId: "1", voiceType: "Авторская" })).toEqual({ label: "Авторский", kind: "avo" });
    expect(voiceOf({ vkId: "1" }).label).toBe("CDNVideoHub");
  });

  it("lists every movie upload as its own voice", () => {
    const vs = movieVoices(parsePlaylist(playlistMovie));
    expect(vs.map((v) => v.label)).toEqual(["Дубляж", "SDI Media", "Гланц и Королёва", "Андрей Гаврилов"]);
    expect(vs[0].kind).toBe("dub");
    expect(new Set(vs.map((v) => v.vkId)).size).toBe(4);
  });

  it("numbers duplicate labels", () => {
    const vs = movieVoices(parsePlaylist({ items: [{ vkId: "1", voiceType: "Дубляж" }, { vkId: "2", voiceType: "Дубляж" }, { vkId: "1", voiceType: "Дубляж" }] }));
    expect(vs.map((v) => [v.key, v.label])).toEqual([
      ["Дубляж", "Дубляж"],
      ["Дубляж #2", "Дубляж (2)"],
    ]);
  });

  it("prefers the remembered voice, else dubbing, else the first", () => {
    const vs = movieVoices(parsePlaylist(playlistMovie));
    expect(pickVoice(vs, "Андрей Гаврилов")?.label).toBe("Андрей Гаврилов");
    expect(pickVoice(vs, "gone")?.kind).toBe("dub");
    expect(pickVoice(vs.slice(1))?.label).toBe("SDI Media");
    expect(pickVoice([])).toBeUndefined();
  });
});

describe("seriesIndex", () => {
  const idx = seriesIndex(parsePlaylist(playlistSeries));
  it("groups seasons → episodes → voices, sorted", () => {
    expect(idx.map((s) => s.season)).toEqual([1, 7]);
    const s1 = idx[0];
    expect(s1.episodes.map((e) => e.episode)).toEqual([...s1.episodes.map((e) => e.episode)].sort((a, b) => a - b));
    const e1 = s1.episodes[0];
    expect(e1.episode).toBe(1);
    expect(e1.voices.map((v) => v.label)).toContain("True Dubbing Studio");
    expect(e1.voices.map((v) => v.label)).toContain("Нота");
    expect(s1.voices.length).toBeGreaterThanOrEqual(2);
  });
  it("ignores movie items and keeps the first upload per voice", () => {
    const i = seriesIndex(
      parsePlaylist({
        items: [
          { vkId: "9", voiceStudio: "A" },
          { vkId: "1", voiceStudio: "A", season: 2, episode: 3 },
          { vkId: "2", voiceStudio: "A", season: 2, episode: 3 },
          { vkId: "3", voiceStudio: "B", season: 2, episode: 1 },
        ],
      }),
    );
    expect(i).toHaveLength(1);
    expect(i[0].episodes.map((e) => [e.episode, e.voices.map((v) => v.vkId)])).toEqual([
      [1, ["3"]],
      [3, ["1"]],
    ]);
    expect(i[0].voices).toEqual(["A", "B"]);
  });
  it("finds the next / previous episode across seasons", () => {
    const last1 = idx[0].episodes[idx[0].episodes.length - 1].episode;
    expect(neighbour(idx, { season: 1, episode: last1 }, 1)).toEqual({ season: 7, episode: idx[1].episodes[0].episode });
    expect(neighbour(idx, { season: 1, episode: 1 }, -1)).toBeNull();
    expect(neighbour(idx, { season: 1, episode: 1 }, 1)?.season).toBe(1);
  });
});

describe("quality ladder", () => {
  it("maps the swapped 2K/4K names and orders best first", () => {
    const l = ladderOf(video.sources);
    expect(l.map((r) => r.q)).toEqual([2160, 1440, 1080, 720, 480, 360, 240, 144]);
    expect(l[0].url).toBe(video.sources.mpeg2kUrl);
    expect(l[1].url).toBe(video.sources.mpeg4kUrl);
    expect(l.find((r) => r.q === 1080)?.url).toBe(video.sources.mpegFullHdUrl);
  });
  it("uses the QHD field for 1440p when the 4K one is empty, skipping blanks", () => {
    expect(ladderOf({ mpeg4kUrl: "", mpegQhdUrl: "q", mpegHighUrl: "h" })).toEqual([
      { q: 1440, url: "q" },
      { q: 720, url: "h" },
    ]);
    expect(ladderOf(null)).toEqual([]);
  });
  it("chooses the best quality not above the wish", () => {
    const have = [2160, 1080, 720, 480];
    expect(chooseQuality(have, 0)).toBe(2160);
    expect(chooseQuality(have, 1080)).toBe(1080);
    expect(chooseQuality(have, 1440)).toBe(1080);
    expect(chooseQuality(have, 360)).toBe(480);
    expect(chooseQuality([], 720)).toBe(0);
  });
  it("parses the video answer with duration, HLS and expiry", () => {
    const v = parseVideo(video);
    expect(v.duration).toBe(8178);
    expect(v.hls).toContain("video.m3u8");
    expect(v.expires).toBe(1793348774601);
    expect(expiryOf("https://x/?expires=1700000000&a=1")).toBe(1700000000000);
    expect(expiryOf("https://x/")).toBe(0);
  });
});
