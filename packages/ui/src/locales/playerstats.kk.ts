// TV player: Kazakh strings for the stats panel and "Show buffer" (mirrors playerstats.en.ts).
import type { playerStatsEn } from "./playerstats.en";

export const playerStatsKk: Record<keyof typeof playerStatsEn, string> = {
  "pstats.peers": "Пирлер {peers} · сидтер {seeders}",
  "pstats.from_peers": "Пирлерден {speed}",
  "pstats.local": "Сервер дискісінен",
  "pstats.server": "Сервер: CPU {cpu}% · ағындар {streams}",
  "pstats.server_streams": "Сервер: ағындар {streams}",
  "pstats.device": "ТВ-ға дейін ≈ {rate} Мбит/с",
  "pstats.device_usual": "ТВ-ға дейін ≈ {rate} Мбит/с (әдетте)",
  "pstats.buffer": "Буфер {ahead} с",
  "pstats.buffer_torrent": "Буфер {ahead} с · TorrServer {size}",
  "pstats.row.prebuffer": "Буферді көрсету",
  "pstats.row.prebuffer_hint": "Алдын ала қанша жүктелгені: прогресс жолағында және плеер бұрышында.",
};
