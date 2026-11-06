import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "@martytv/ui";
import {
  applyUpdate,
  canDownloadSeason,
  chipInfo,
  diskSegments,
  downloadsFor,
  formatEta,
  formatKeepDate,
  formatRate,
  inactiveTorrents,
  keepDaysFrom,
  primaryDownload,
  progressPercent,
  sizeLine,
  sortDownloads,
  type Download,
} from "./format";

const ru = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);
const en = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);
const NOW = Date.parse("2026-10-29T12:00:00Z");

function dl(o: Partial<Download> = {}): Download {
  return {
    id: "d1",
    status: "downloading",
    error: null,
    progress: 0.42,
    bytes_done: 1_900_000_000,
    size: 4_500_000_000,
    rate_bps: 1.2 * 1024 * 1024,
    eta_seconds: 35 * 60,
    pinned: false,
    mine: true,
    info_hash: "abc",
    file_index: 1,
    file_name: "Movie.2010.mkv",
    release_title: "Movie (2010)",
    media_id: "m1",
    episode_id: null,
    season: null,
    episode: null,
    media: null,
    created_at: "2026-10-28T10:00:00Z",
    started_at: null,
    completed_at: null,
    last_watched_at: null,
    keep_until: null,
    space_needed_bytes: null,
    ...o,
  };
}

describe("formatting", () => {
  it("formats ETA", () => {
    expect(formatEta(35 * 60, "ru")).toBe("~35 мин");
    expect(formatEta(2 * 3600 + 10 * 60, "ru")).toBe("~2 ч 10 мин");
    expect(formatEta(3600, "en")).toBe("~1 h");
    expect(formatEta(10, "en")).toBe("~1 min");
    expect(formatEta(null, "ru")).toBeNull();
  });

  it("formats rate with a comma in ru", () => {
    expect(formatRate(1.2 * 1024 * 1024, "ru")).toBe("1,2 МБ/с");
    expect(formatRate(1.2 * 1024 * 1024, "en")).toBe("1.2 MB/s");
    expect(formatRate(500 * 1024, "ru")).toBe("500 КБ/с");
    expect(formatRate(0, "ru")).toBeNull();
    expect(formatRate(null, "en")).toBeNull();
  });

  it("formats keep-until dates", () => {
    expect(formatKeepDate("2026-11-28T10:00:00Z", "ru", NOW)).toBe("28.11");
    expect(formatKeepDate("2026-11-28T10:00:00Z", "en", NOW)).toBe("Nov 28");
    expect(formatKeepDate("2027-01-05T10:00:00Z", "ru", NOW)).toBe("05.01.2027");
    expect(formatKeepDate(null, "ru", NOW)).toBeNull();
  });

  it("caps progress below 100 until done", () => {
    expect(progressPercent({ status: "downloading", progress: 0.429 })).toBe(42);
    expect(progressPercent({ status: "downloading", progress: 0.999 })).toBe(99);
    expect(progressPercent({ status: "done", progress: 0.5 })).toBe(100);
    expect(progressPercent({ status: "queued", progress: Number.NaN })).toBe(0);
  });
});

describe("chip text", () => {
  it("shows progress, rate and ETA while downloading", () => {
    expect(chipInfo(dl(), ru, "ru", NOW)).toEqual({ tone: "progress", text: "Загружается 42% · 1,2 МБ/с · ~35 мин" });
    expect(chipInfo(dl({ rate_bps: null, eta_seconds: null }), en, "en", NOW).text).toBe("Downloading 42%");
  });

  it("covers every status", () => {
    expect(chipInfo(dl({ status: "queued" }), ru, "ru", NOW).text).toBe("В очереди");
    expect(chipInfo(dl({ status: "waiting_space" }), ru, "ru", NOW).text).toBe("Ждёт места на диске");
    expect(chipInfo(dl({ status: "paused" }), ru, "ru", NOW).text).toBe("Пауза · 42%");
    expect(chipInfo(dl({ status: "failed" }), ru, "ru", NOW)).toEqual({ tone: "error", text: "Ошибка загрузки" });
    expect(chipInfo(dl({ status: "done", keep_until: "2026-11-28T10:00:00Z" }), ru, "ru", NOW).text).toBe("На сервере ✓ · хранится до 28.11");
    expect(chipInfo(dl({ status: "done", pinned: true }), ru, "ru", NOW).text).toBe("На сервере ✓ · закреплено");
    expect(chipInfo(dl({ status: "done" }), en, "en", NOW).text).toBe("On server ✓");
  });

  it("size line", () => {
    expect(sizeLine(dl(), ru, "ru", NOW)).toBe("1,8 ГБ из 4,2 ГБ · 1,2 МБ/с · ~35 мин");
    expect(sizeLine(dl({ status: "done", keep_until: "2026-11-28T10:00:00Z" }), ru, "ru", NOW)).toBe("4,2 ГБ · хранится до 28.11");
  });
});

describe("selection and sorting", () => {
  it("matches movie and episode downloads", () => {
    const items = [dl({ id: "movie" }), dl({ id: "e1", episode_id: "ep1", season: 1, episode: 1 }), dl({ id: "e2", season: 1, episode: 2 })];
    expect(downloadsFor(items, {}).map((d) => d.id)).toEqual(["movie"]);
    expect(downloadsFor(items, { episode_id: "ep1", season_number: 1, episode_number: 1 }).map((d) => d.id)).toEqual(["e1"]);
    expect(downloadsFor(items, { episode_id: "epX", season_number: 1, episode_number: 2 }).map((d) => d.id)).toEqual(["e2"]);
  });

  it("prefers a running download for the chip", () => {
    const p = primaryDownload([dl({ id: "a", status: "failed" }), dl({ id: "b", status: "done" }), dl({ id: "c", status: "downloading" })]);
    expect(p?.id).toBe("c");
    expect(primaryDownload([])).toBeNull();
  });

  it("sorts by size and by age", () => {
    const a = dl({ id: "a", size: 1, created_at: "2026-10-01T00:00:00Z" });
    const b = dl({ id: "b", size: 3, created_at: "2026-10-03T00:00:00Z", completed_at: "2026-10-04T00:00:00Z" });
    const c = dl({ id: "c", size: 2, created_at: "2026-10-02T00:00:00Z" });
    expect(sortDownloads([a, b, c], "size").map((d) => d.id)).toEqual(["b", "c", "a"]);
    expect(sortDownloads([a, b, c], "age").map((d) => d.id)).toEqual(["a", "c", "b"]);
    expect(sortDownloads([a, b, c], "newest").map((d) => d.id)).toEqual(["b", "c", "a"]);
  });

  it("knows season packs", () => {
    expect(canDownloadSeason({ is_season_pack: true, seasons: [1], episodes: [] })).toBe(true);
    expect(canDownloadSeason({ is_season_pack: false, seasons: [2], episodes: [] })).toBe(true);
    expect(canDownloadSeason({ is_season_pack: false, seasons: [2], episodes: [3] })).toBe(false);
    expect(canDownloadSeason({ is_season_pack: false, seasons: [], episodes: [] })).toBe(false);
  });

  it("finds inactive torrents", () => {
    const t = (hash: string, idle: boolean, in_use: boolean) => ({ hash, idle, martytv: { sources: 0, streaming: false, download: null, in_use } });
    expect(inactiveTorrents([t("a", true, false), t("b", true, true), t("c", false, false)]).map((x) => x.hash)).toEqual(["a"]);
  });
});

describe("storage", () => {
  it("splits the disk into other / library / reserve / free", () => {
    const s = diskSegments({ disk_total_bytes: 1000, disk_free_bytes: 400, library_used_bytes: 250, reserve_bytes: 100 });
    expect(s).toEqual({ other: 350, library: 250, reserve: 100, free: 300, total: 1000 });
    expect(diskSegments({ disk_total_bytes: 1000, disk_free_bytes: 50, library_used_bytes: 2000, reserve_bytes: 100 })).toEqual({
      other: 0,
      library: 950,
      reserve: 50,
      free: 0,
      total: 1000,
    });
  });

  it("derives keep days from a done download", () => {
    const done = dl({ status: "done", completed_at: "2026-10-01T00:00:00Z", keep_until: "2026-10-15T00:00:00Z" });
    expect(keepDaysFrom([dl(), done])).toBe(14);
    expect(keepDaysFrom([dl({ ...done, last_watched_at: "2026-10-05T00:00:00Z", keep_until: "2026-11-04T00:00:00Z" })])).toBe(30);
    expect(keepDaysFrom([dl()], 30)).toBe(30);
  });
});

describe("cache updates", () => {
  it("merges realtime payloads and keeps the cached media", () => {
    const media = { id: "m1", title: "Movie" } as Download["media"];
    const list = [dl({ media, progress: 0.1 })];
    const next = applyUpdate(list, dl({ progress: 0.5, media: null }), {});
    expect(next?.[0]?.progress).toBe(0.5);
    expect(next?.[0]?.media).toBe(media);
  });

  it("asks for a refetch when a matching download is new", () => {
    expect(applyUpdate([], dl({ id: "new" }), { media_id: "m1" })).toBeNull();
    const list = [dl()];
    expect(applyUpdate(list, dl({ id: "other", media_id: "m2" }), { media_id: "m1" })).toBe(list);
  });

  it("drops a download that left a status-filtered list", () => {
    expect(applyUpdate([dl()], dl({ status: "done" }), { status: "downloading" })).toEqual([]);
  });
});

describe("short chip", () => {
  it("drops details shown elsewhere in the row", () => {
    expect(chipInfo(dl(), ru, "ru", NOW, true).text).toBe("Загружается 42%");
    expect(chipInfo(dl({ status: "done", pinned: true }), ru, "ru", NOW, true).text).toBe("На сервере ✓");
  });
});
