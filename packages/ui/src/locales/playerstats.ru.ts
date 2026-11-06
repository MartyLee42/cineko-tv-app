// TV player: русские строки панели статистики и «Показывать буфер» (зеркало playerstats.en.ts).
import type { playerStatsEn } from "./playerstats.en";

export const playerStatsRu: Record<keyof typeof playerStatsEn, string> = {
  "pstats.peers": "Пиров {peers} · сидов {seeders}",
  "pstats.from_peers": "{speed} с пиров",
  "pstats.local": "С диска сервера",
  "pstats.server": "Сервер: CPU {cpu}% · потоков {streams}",
  "pstats.server_streams": "Сервер: потоков {streams}",
  "pstats.device": "До ТВ ≈ {rate} Мбит/с",
  "pstats.device_usual": "До ТВ ≈ {rate} Мбит/с (обычно)",
  "pstats.buffer": "Буфер {ahead} с",
  "pstats.buffer_torrent": "Буфер {ahead} с · TorrServer {size}",
  "pstats.row.prebuffer": "Показывать буфер",
  "pstats.row.prebuffer_hint": "Сколько загружено наперёд: на полосе прогресса и в углу плеера.",
};
