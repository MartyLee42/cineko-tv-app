// «Мгновенный старт» on Details: once the page has stayed on what Play would
// start for a couple of seconds, the server warms it (packages/media-types
// instantPlay.ts); leaving the page or another target cancels it.
import { useEffect, useState } from "react";
import { createWarmer, type WarmTarget } from "@martytv/media-types";
import { api } from "../api";

export function warmPlayback(t: WarmTarget): Promise<unknown> {
  return api.POST("/playback/warm", { body: t });
}

export function cancelWarm(profileId: string): void {
  void api.DELETE("/playback/warm", { params: { query: { profile_id: profileId } } }).catch(() => undefined);
}

/** Warms `target` (null = nothing) while the calling screen is mounted; `allowed` (fixed) is asked before each warm. */
export function useInstantPlay(target: WarmTarget | null, allowed: () => boolean) {
  const [warmer] = useState(() => createWarmer({ warm: warmPlayback, cancel: cancelWarm, allowed }));
  // An equal target (same key) is a no-op in the warmer.
  useEffect(() => {
    warmer.set(target);
  }, [warmer, target]);
  useEffect(() => () => warmer.dispose(), [warmer]);
}
