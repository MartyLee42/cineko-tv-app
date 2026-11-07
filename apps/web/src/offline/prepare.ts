// Device downloads: from a title / episode to a URL worth saving. Picks the
// release the in-browser player would pick (best for this browser), prepares
// a playback source (or refreshes the known one: GET renews its stream link),
// waits for it, and decides between the original file and the compat MP4.
import { ApiError, unwrap, type PlaybackSource } from "@martytv/contracts";
import { api, queryClient } from "../api";
import { compatSrc, pickCompatAudio, readCompatPref } from "../player/compat";
import { assessHere, assessSource, bestForBrowser, thisBrowser } from "../play/browserSupport";
import { apiErrorCode, createSource, releasesQuery, sourceKey } from "../play/queries";
import { rememberedRefine } from "../play/refine";
import { isTorrentRelease } from "../downloads/format";
import { clientId } from "../devprefs/logic";
import { chooseMode, type DeviceError, type SaveMode } from "./logic";
import type { DeviceItem } from "./items";

/** A failure with a reason the UI can explain. */
export class DeviceFail extends Error {
  constructor(
    public error: DeviceError,
    public code?: string,
    public vars?: Record<string, string | number>,
  ) {
    super(`device download: ${error}${code ? ` (${code})` : ""}`);
    this.name = "DeviceFail";
  }
}

export interface Prepared {
  url: string;
  mode: SaveMode;
  /** Exact bytes (original files); null for compat. */
  total: number | null;
  /** Rough bytes for the space check (the file's size). */
  expected: number | null;
  duration: number | null;
  releaseId: string;
  sourceId: string;
  audio?: number | null;
  video?: boolean;
  type: string;
}

const PREPARE_TIMEOUT = 5 * 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

async function getSource(id: string): Promise<PlaybackSource | null> {
  try {
    const s = await unwrap(api.GET("/playback/sources/{id}", { params: { path: { id } } }));
    queryClient.setQueryData(sourceKey(id), s);
    return s;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
    throw toFail(e);
  }
}

function toFail(e: unknown): DeviceFail {
  if (e instanceof DeviceFail) return e;
  if (e instanceof ApiError) return e.status === 0 ? new DeviceFail(navigator.onLine ? "network" : "offline") : new DeviceFail("source", apiErrorCode(e));
  if ((e as { name?: string } | null)?.name === "AbortError") throw e;
  return new DeviceFail(navigator.onLine ? "network" : "offline");
}

async function audioPrefs(profileId: string | null) {
  if (!profileId) return {};
  try {
    const p = await queryClient.fetchQuery({
      queryKey: ["profile-prefs", profileId],
      queryFn: () => unwrap(api.GET("/profiles/{id}/preferences", { params: { path: { id: profileId } } })),
      staleTime: 5 * 60_000,
    });
    return { voiceovers: p.preferred_voiceovers ?? [], languages: p.preferred_audio_languages ?? [] };
  } catch {
    return {};
  }
}

/** The release the player would pick here (torrents only: online variants can't be saved). */
async function pickRelease(it: DeviceItem): Promise<string> {
  const target = {
    media_id: it.mediaId!,
    ...(it.season != null && { season_number: it.season }),
    ...(it.episode != null && { episode_number: it.episode }),
    ...(it.episodeId && { episode_id: it.episodeId }),
  };
  let list;
  try {
    list = await queryClient.fetchQuery(releasesQuery(target, it.profileId ?? undefined, it.lang, rememberedRefine(it.mediaId!), { client_id: clientId() }));
  } catch (e) {
    throw toFail(e);
  }
  const torrents = list.items.filter(isTorrentRelease);
  const best = bestForBrowser(torrents, assessHere) ?? torrents[0];
  if (!best) throw new DeviceFail("no_releases");
  return best.id;
}

export async function prepareDownload(it: DeviceItem, signal: AbortSignal): Promise<Prepared> {
  if (!it.mediaId) throw new DeviceFail("failed");
  let src = it.sourceId ? await getSource(it.sourceId) : null;
  if (!src || src.status === "error" || (it.releaseId && src.release.id !== it.releaseId)) {
    const releaseId = it.releaseId ?? (await pickRelease(it));
    try {
      src = await createSource({
        media_id: it.mediaId,
        release_id: releaseId,
        ...(it.episodeId && { episode_id: it.episodeId }),
        ...(it.profileId && { profile_id: it.profileId }),
      });
    } catch (e) {
      throw toFail(e);
    }
  }
  const started = Date.now();
  while (src.status === "preparing") {
    if (Date.now() - started > PREPARE_TIMEOUT) throw new DeviceFail("source", "no_metadata");
    await sleep(1500, signal);
    const next = await getSource(src.id);
    if (!next) throw new DeviceFail("expired");
    src = next;
  }
  if (src.status === "error" || !src.stream_url) throw new DeviceFail("source", src.error ?? undefined);
  if (src.kind && src.kind !== "torrent") throw new DeviceFail("format");
  // ffprobe info arrives shortly after "ready": the verdict is better with it.
  for (let i = 0; i < 4 && !src.media_info; i++) {
    await sleep(2000, signal);
    src = (await getSource(src.id)) ?? src;
  }

  const { probe, env } = thisBrowser();
  const support = assessSource(src, probe, env);
  let mode: SaveMode;
  let video: boolean;
  if (it.mode) {
    // Fixed by the player («save what plays here») or by bytes already stored.
    mode = it.mode === "compat" && !src.compat_url ? "original" : it.mode;
    video = !!it.video;
  } else {
    const c = chooseMode({ support, compatUrl: src.compat_url, compatVideo: src.compat_video, pref: readCompatPref() });
    if (c.mode === null) {
      const bad = support.reasons.find((r) => r.severity === "unlikely");
      throw new DeviceFail("format", undefined, bad ? { codec: bad.label } : undefined);
    }
    mode = c.mode;
    video = c.mode === "compat" && c.video;
  }
  const size = src.file?.size_bytes ?? src.release.size_bytes ?? null;
  const base = {
    releaseId: src.release.id,
    sourceId: src.id,
    duration: src.media_info?.duration_seconds ?? null,
    expected: size,
  };
  if (mode === "compat" && src.compat_url) {
    const audio = it.audio ?? pickCompatAudio(src.media_info, await audioPrefs(it.profileId));
    let url = compatSrc(src.compat_url, { audio, start: 0 });
    if (video) url += `${url.includes("?") ? "&" : "?"}video=h264`;
    return { ...base, url, mode, total: null, audio, video, type: "video/mp4" };
  }
  if (!src.stream_url) throw new DeviceFail("source");
  return { ...base, url: src.stream_url, mode: "original", total: src.file?.size_bytes ?? null, type: src.mime_type || "video/mp4" };
}
