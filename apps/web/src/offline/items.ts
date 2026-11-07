// Device downloads: the stored item and its pure store helpers (tested).
import { NEW_JOB, isRunning, jobReducer, type JobState, type SaveMode } from "./logic";

export interface DeviceItem extends JobState {
  id: string; // `${media_id}:${episode_id ?? "movie"}`
  mediaId: string | null;
  episodeId: string | null;
  season: number | null;
  episode: number | null;
  title: string;
  subtitle: string | null;
  poster: string | null;
  /** The release (null: pick the best for this browser when preparing). */
  releaseId: string | null;
  /** A playback source to reuse (its stream URL is refreshed on GET). */
  sourceId: string | null;
  profileId: string | null;
  lang: "ru" | "en";
  /** What is (being) saved; fixed once bytes are stored. */
  mode: SaveMode | null;
  /** Compat: the audio track (stream index) and video re-encoding. */
  audio?: number | null;
  video?: boolean;
  size: number;
  duration: number | null;
  type?: string;
  at: number;
  position?: number; // offline resume (seconds)
  /** Saved before chunks: one Cache Storage entry at /offline-video/<id>. */
  legacy?: boolean;
  /** Paused for lack of connection: resumes on "online". */
  autoResume?: boolean;
  /** An automatic retry is scheduled for this time. */
  retryAt?: number;
}

export type Stored = Partial<DeviceItem> & { id: string };

/** Items saved by older builds have no status: they are saved single entries. */
export function migrateItem(x: Stored): DeviceItem {
  const legacy = x.status == null;
  const size = x.size ?? 0;
  return {
    ...NEW_JOB,
    mediaId: null,
    episodeId: null,
    season: null,
    episode: null,
    title: "",
    subtitle: null,
    poster: null,
    releaseId: null,
    sourceId: null,
    profileId: null,
    lang: "ru",
    mode: null,
    size,
    duration: null,
    at: 0,
    ...x,
    ...(legacy && { status: "saved" as const, legacy: true, bytes: size, total: size }),
  } as DeviceItem;
}

/** After a reload nothing runs: running jobs become paused (compat ones lose their bytes). */
export function interruptItem(it: DeviceItem): DeviceItem {
  if (!isRunning(it.status)) return it;
  return { ...it, ...jobReducer(it, { type: "pause", keepChunks: it.mode === "original" }) };
}

