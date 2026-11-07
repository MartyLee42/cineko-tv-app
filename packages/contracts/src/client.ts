import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];
export type User = Schemas["User"];
export type Profile = Schemas["Profile"];
export type Device = Schemas["Device"];
export type MediaSummary = Schemas["MediaSummary"];
export type MediaDetail = Schemas["MediaDetail"];
export type MediaPage = Schemas["MediaPage"];
export type HomeRow = Schemas["HomeRow"];
export type Season = Schemas["Season"];
export type Episode = Schemas["Episode"];
export type Genre = Schemas["Genre"];
export type CatalogConfig = Schemas["CatalogConfig"];
export type MediaKind = Schemas["MediaKind"];
export type DeviceState = Schemas["DeviceState"];
export type PlaybackState = Schemas["PlaybackState"];
export type PlaybackLoading = Schemas["PlaybackLoading"];
export type VideoPlaybackState = Schemas["VideoPlaybackState"];
export type CommandType = Schemas["CommandType"];
export type CommandErrorCode = Schemas["CommandErrorCode"];
export type CommandAck = Schemas["CommandAck"];
export type CommandSender = Schemas["CommandSender"];
export type MediaOpenPayload = Schemas["MediaOpenPayload"];
export type MediaPlayPayload = Schemas["MediaPlayPayload"];
export type PlayerKind = Schemas["PlayerKind"];
export type ProfileSettings = Schemas["ProfileSettings"];
export type MediaUserState = Schemas["MediaUserState"];
export type WatchProgress = Schemas["WatchProgress"];
export type MediaProgress = Schemas["MediaProgress"];
export type ContinueItem = Schemas["ContinueItem"];
export type HistoryItem = Schemas["HistoryItem"];
export type NextUp = Schemas["NextUp"];
export type ActivityItem = Schemas["ActivityItem"];
export type AdminHistoryItem = Schemas["AdminHistoryItem"];
export type Message = Schemas["Message"];
export type SentMessage = Schemas["SentMessage"];
export type Recommendation = Schemas["Recommendation"];
export type PersonRef = Schemas["PersonRef"];
export type Release = Schemas["Release"];
export type Voiceover = Schemas["Voiceover"];
export type ReleaseList = Schemas["ReleaseList"];
export type PlaybackSource = Schemas["PlaybackSource"];
export type TorrentFile = Schemas["TorrentFile"];
export type MediaInfo = Schemas["MediaInfo"];
export type IptvChannel = Schemas["IptvChannel"];
export type IptvProgramme = Schemas["IptvProgramme"];
export type IptvGroup = Schemas["IptvGroup"];
export type VideoItem = Schemas["VideoItem"];
export type VideoDetail = Schemas["VideoDetail"];
export type VideoChannelRef = Schemas["VideoChannelRef"];
export type VideoChannel = Schemas["VideoChannel"];

/** Payload type for each realtime command (see openapi.yaml *Payload schemas). */
export interface CommandPayloads {
  "media.open": Schemas["MediaOpenPayload"];
  "media.play": Schemas["MediaPlayPayload"];
  "media.pause": undefined;
  "media.resume": undefined;
  "media.stop": undefined;
  "media.seek": Schemas["SeekPayload"];
  "media.next_episode": undefined;
  "media.select_source": Schemas["SelectSourcePayload"];
  "playback.set_audio": Schemas["SetTrackPayload"];
  "playback.set_subtitles": Schemas["SetTrackPayload"];
  "playback.set_volume": Schemas["SetVolumePayload"];
  "device.show_message": Schemas["ShowMessagePayload"];
  "device.request_state": undefined;
  "iptv.play": Schemas["IptvPlayPayload"];
  "video.play": Schemas["VideoPlayPayload"];
}

/** Error thrown by `unwrap` for any non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
  readonly requestId?: string;
  readonly retryAfter?: number;

  constructor(status: number, body: unknown, retryAfter?: number) {
    const err = (body as Schemas["Error"] | undefined)?.error;
    super(err?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = err?.code ?? (status === 0 ? "network_error" : "error");
    this.fields = err?.fields ?? {};
    this.requestId = err?.request_id;
    this.retryAfter = retryAfter;
  }
}

export interface ApiOptions {
  /** Origin of the API; empty for same-origin (the default deployment). */
  baseUrl?: string;
  /** CSRF token for cookie sessions (browser). */
  getCsrfToken?: () => string | undefined;
  /** Bearer credential (TV device credential). */
  getBearer?: () => string | undefined;
  /** Called on 401 so the app can return to login/pairing (with the rejected request). */
  onUnauthorized?: (request: Request) => void;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createApi(opts: ApiOptions = {}) {
  const client = createClient<paths>({
    baseUrl: `${opts.baseUrl ?? ""}/api/v1`,
    credentials: "same-origin",
  });
  const auth: Middleware = {
    onRequest({ request }) {
      const bearer = opts.getBearer?.();
      if (bearer && !request.headers.has("Authorization")) {
        request.headers.set("Authorization", `Bearer ${bearer}`);
      }
      const csrf = opts.getCsrfToken?.();
      if (csrf && UNSAFE.has(request.method)) {
        request.headers.set("X-CSRF-Token", csrf);
      }
      return request;
    },
    onResponse({ response, request }) {
      // Pairing polls use their own auth scheme; their 401s are not "signed out".
      if (response.status === 401 && !request.url.includes("/pairing")) {
        opts.onUnauthorized?.(request);
      }
      return response;
    },
  };
  client.use(auth);
  return client;
}

export type Api = ReturnType<typeof createApi>;

/** Returns `data` or throws ApiError. Use with every openapi-fetch call. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let res: { data?: T; error?: unknown; response: Response };
  try {
    res = await call;
  } catch {
    throw new ApiError(0, { error: { code: "network_error", message: "Cannot reach the server." } });
  }
  if (!res.response.ok) {
    const ra = Number(res.response.headers.get("Retry-After")) || undefined;
    throw new ApiError(res.response.status, res.error, ra);
  }
  return res.data as T;
}
