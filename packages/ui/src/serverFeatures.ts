// What this server has (GET /status `features`, set by install.sh options):
// apps hide the «Видео» tab without video, Cineko Music links without music,
// and say «поиск раздач не настроен» without a torrent backend. Absent (an
// older server) or not loaded yet = everything on.
export interface ServerFeatures {
  video: boolean;
  music: boolean;
  torrents: boolean;
}

export const ALL_FEATURES: ServerFeatures = { video: true, music: true, torrents: true };

export function serverFeatures(status: { features?: Partial<ServerFeatures> | null } | null | undefined): ServerFeatures {
  const f = status?.features;
  if (!f) return ALL_FEATURES;
  return { video: f.video !== false, music: f.music !== false, torrents: f.torrents !== false };
}
