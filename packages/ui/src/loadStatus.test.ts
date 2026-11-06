import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { loadStatus, type LoadStatusInput, type LoadTorrent } from "./loadStatus";
import { isSlowFor, slowSince, SLOW_TORRENT_HOLD_MS } from "./slowTorrent";

const MB = 1024 * 1024;
const fmt = { bytes: (n: number) => `${Math.round(n / MB)} МБ`, speed: (b: number) => `${(b / MB).toFixed(1)} МБ/с` };
const ru = (i: LoadStatusInput) => {
  const s = loadStatus(i, fmt);
  return [translate("ru", s.status.key, s.status.vars), ...s.stats.map((l) => translate("ru", l.key, l.vars))];
};
const tor = (o: Partial<LoadTorrent> = {}): LoadTorrent => ({ peers: 14, seeders: 9, download_speed_bps: 2.5 * MB, preloaded_bytes: 0, ...o });

describe("loading status", () => {
  it("names each stage before any torrent numbers exist", () => {
    expect(ru({ stage: "resolving", torrent: null })).toEqual(["Подготовка…"]);
    expect(ru({ stage: "searching", torrent: null })).toEqual(["Ищем раздачи…"]);
    expect(ru({ stage: "creating", torrent: null })).toEqual(["Добавляем раздачу…"]);
    // Never an empty stats line while the torrent is still being fetched.
    expect(ru({ stage: "metadata", torrent: null })).toEqual(["Получаем метаданные…", "Ищем пиров…"]);
  });

  it("shows peers (of known), seeders and speed; no peers yet = connecting", () => {
    expect(ru({ stage: "metadata", torrent: tor({ peers: 0, seeders: 0, total_peers: 31 }) })).toEqual([
      "Подключаемся к пирам…",
      "Пиров: 0 из 31 · сидов: 0",
      "↓ 2.5 МБ/с",
    ]);
    expect(ru({ stage: "metadata", torrent: tor() })).toEqual(["Получаем метаданные…", "Пиров: 14 · сидов: 9", "↓ 2.5 МБ/с"]);
  });

  it("counts the buffer towards TorrServer's preload size, else the client's target", () => {
    expect(ru({ stage: "preloading", torrent: tor({ preloaded_bytes: 12 * MB, preload_size: 20 * MB }) })[0]).toBe("Буферизация 12 МБ из 20 МБ");
    expect(ru({ stage: "starting", torrent: tor({ preloaded_bytes: 4 * MB }), target: 16 * MB })[0]).toBe("Буферизация 4 МБ из 16 МБ");
    // Past the goal: the amount moves to the stats line.
    expect(ru({ stage: "starting", torrent: tor({ preloaded_bytes: 40 * MB }), target: 16 * MB })).toEqual([
      "Запускаем воспроизведение…",
      "Пиров: 14 · сидов: 9",
      "↓ 2.5 МБ/с",
      "Загружено: 40 МБ",
    ]);
  });

  it("converting audio / video for this device; online sources have no torrent numbers", () => {
    expect(ru({ stage: "starting", torrent: tor(), compat: "audio" })[0]).toBe("Конвертируем звук…");
    expect(ru({ stage: "starting", torrent: tor(), compat: "video" })[0]).toBe("Конвертируем видео…");
    expect(ru({ stage: "metadata", torrent: null, online: true })).toEqual(["Получаем метаданные…"]);
    expect(ru({ stage: "creating", torrent: null, online: true })).toEqual(["Получаем поток…"]);
  });

  it("English mirrors it", () => {
    const s = loadStatus({ stage: "preloading", torrent: tor({ preloaded_bytes: 12 * MB, preload_size: 20 * MB, total_peers: 80 }) }, fmt);
    expect(translate("en", s.status.key, s.status.vars)).toBe("Buffering 12 МБ of 20 МБ");
    expect(s.stats.map((l) => translate("en", l.key, l.vars))).toEqual(["Peers: 14 of 80 · seeders: 9", "↓ 2.5 МБ/с"]);
  });
});

describe("slow torrent", () => {
  it("needs the speed below the release's bitrate for the whole hold", () => {
    const need = 0.58 * MB * 8; // «Ленин в Октябре»: 3.67 GB over 6295 s
    let since: number | null = null;
    since = slowSince(since, 0.46 * MB, need, 1000);
    expect(since).toBe(1000);
    since = slowSince(since, 0.4 * MB, need, 5000);
    expect(isSlowFor(since, 5000)).toBe(false);
    expect(isSlowFor(since, 1000 + SLOW_TORRENT_HOLD_MS)).toBe(true);
    // Fast enough again: the window restarts.
    expect(slowSince(since, 0.7 * MB, need, 9000)).toBeNull();
    // Unknown numbers or bitrate: never slow.
    expect(slowSince(null, null, need, 1)).toBeNull();
    expect(slowSince(null, 0, null, 1)).toBeNull();
  });
});
