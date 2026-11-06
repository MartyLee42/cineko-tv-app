// Network side of the in-browser player: the reporter's transport and the
// watch-here preferences kept in this browser.
import { unwrap } from "@martytv/contracts";
import { api } from "../api";
import type { ReportBody, SessionStart, SessionTarget, Transport } from "./reporter";

const progressUrl = (id: string) => `/api/v1/playback/sessions/${encodeURIComponent(id)}/progress`;

export const sessionTransport: Transport = {
  start: (t: SessionTarget) =>
    unwrap(
      api.POST("/playback/sessions", {
        body: {
          profile_id: t.profile_id,
          media_id: t.media_id,
          ...(t.episode_id && { episode_id: t.episode_id }),
          ...(t.source_id && { source_id: t.source_id }),
        },
      }),
    ) as Promise<SessionStart>,
  report: (id: string, body: ReportBody) => unwrap(api.POST("/playback/sessions/{id}/progress", { params: { path: { id } }, body })),
  /**
   * sendBeacon can't set headers: the session's report token authenticates
   * it (`?token=`, text/plain JSON). Without a token (or when the beacon is
   * refused) a keepalive fetch with the cookie + CSRF header is used.
   */
  beacon: (id: string, body: ReportBody, token: string | null) => {
    const json = JSON.stringify(body);
    if (token && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      try {
        if (navigator.sendBeacon(`${progressUrl(id)}?token=${encodeURIComponent(token)}`, new Blob([json], { type: "text/plain" }))) return;
      } catch {
        // fall through to fetch
      }
    }
    void api
      .POST("/playback/sessions/{id}/progress", { params: { path: { id } }, body, keepalive: true } as never)
      .catch(() => undefined);
  },
};

// ---------------------------------------------------------------- "where" preference

export type WatchWhere = "tv" | "here";
const WHERE_KEY = "martytv.watch_where";

/** Last choice between TV and this device (Continue watching). */
export function readWatchWhere(): WatchWhere | null {
  try {
    const v = localStorage.getItem(WHERE_KEY);
    return v === "tv" || v === "here" ? v : null;
  } catch {
    return null;
  }
}

export function writeWatchWhere(v: WatchWhere) {
  try {
    localStorage.setItem(WHERE_KEY, v);
  } catch {
    // private mode
  }
}
