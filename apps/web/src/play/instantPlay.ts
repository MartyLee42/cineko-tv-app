// «Мгновенный старт» on the title page (PWA): when Play plays here — no TV
// to choose, or «здесь» was the last choice — the release /watch/new would
// pick (the same cached list and ranking) is warmed on the server once the
// page has stayed on it for a couple of seconds. «На ТВ» warms nothing: the
// TV ranks for its own decoder (and warms on its own Details page).
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createWarmer, saveDataOn, WARM_DELAY_MS, type WarmTarget } from "@martytv/media-types";
import { api } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { clientId } from "../devprefs/logic";
import { useActiveProfile } from "../watch/ActiveProfile";
import { assessHere, bestForBrowser } from "./browserSupport";
import { releasesQuery } from "./queries";
import { rememberedRefine } from "./refine";
import type { PlayTarget } from "./PlayOnTv";

function warmPlayback(t: WarmTarget): Promise<unknown> {
  return api.POST("/playback/warm", { body: t });
}

function cancelWarm(profileId: string): void {
  void api.DELETE("/playback/warm", { params: { query: { profile_id: profileId } } }).catch(() => undefined);
}

/** Warms what «Смотреть здесь» would start for `target` while `here` holds. */
export function useWebInstantPlay(target: PlayTarget, here: boolean) {
  const qc = useQueryClient();
  const lang = useCatalogLang();
  const { profileId } = useActiveProfile();
  // The delay runs before the release lookup, so the warmer itself sends at once.
  const [warmer] = useState(() => createWarmer({ warm: warmPlayback, cancel: cancelWarm, delayMs: 0 }));
  const { media_id: mediaId, episode_id: episodeId, season_number: season, episode_number: episode, position_seconds: at } = target;
  const on = here && !!profileId;

  useEffect(() => {
    warmer.set(null); // another target / not here: the previous warm goes
    if (!on || !profileId || saveDataOn()) return;
    let live = true;
    const id = setTimeout(() => {
      const t = { media_id: mediaId, ...(season != null && { season_number: season }), ...(episode != null && { episode_number: episode }) };
      void qc
        .fetchQuery(releasesQuery(t, profileId, lang, rememberedRefine(mediaId), { client_id: clientId() }))
        .then((list) => {
          const best = bestForBrowser(list.items, assessHere, { tried: [] }) ?? list.items[0] ?? null;
          if (!live || !best) return;
          warmer.set({
            media_id: mediaId,
            profile_id: profileId,
            release_id: best.id,
            ...(episodeId && { episode_id: episodeId }),
            ...(at && { start_seconds: at }),
          });
        })
        .catch(() => undefined);
    }, WARM_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [warmer, on, profileId, mediaId, episodeId, season, episode, at, lang, qc]);
  useEffect(() => () => warmer.dispose(), [warmer]);
}
