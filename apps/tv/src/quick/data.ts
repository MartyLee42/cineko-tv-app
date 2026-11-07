// Quick actions' writes: the same endpoints as Details / the web title page
// (lists, ratings, «Не интересно»), with `me` patched optimistically on
// every cached copy of the title so rows, grids and Details agree at once.
import { unwrap, type MediaSummary } from "@martytv/contracts";
import { patchMediaMe, type MeState } from "@martytv/media-types";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { activeProfile } from "../profile/active";
import { dismiss } from "../foryou/queries";

export type ListName = "watchlist" | "favorites";

/** Patches `me` of `mediaId` in every cached query (only queries that contain it are touched). */
export function patchMeEverywhere(mediaId: string, patch: Partial<MeState>) {
  for (const q of queryClient.getQueryCache().findAll()) {
    const d = q.state.data;
    if (d === undefined) continue;
    const next = patchMediaMe(d, mediaId, patch);
    if (next !== d) queryClient.setQueryData(q.queryKey, next);
  }
}

const listPatch = (list: ListName, on: boolean): Partial<MeState> => (list === "watchlist" ? { in_watchlist: on } : { favorite: on });

/** Adds/removes a title from «Буду смотреть» / «Нравится» (favorites). Rolls back on failure. */
export async function setListed(list: ListName, mediaId: string, on: boolean): Promise<void> {
  const profile = activeProfile.get();
  if (!profile) return;
  patchMeEverywhere(mediaId, listPatch(list, on));
  const opts = { params: { path: { id: profile, list, mediaId } } };
  try {
    await unwrap(on ? api.PUT("/profiles/{id}/lists/{list}/{mediaId}", opts) : api.DELETE("/profiles/{id}/lists/{list}/{mediaId}", opts));
  } catch {
    patchMeEverywhere(mediaId, listPatch(list, !on));
  } finally {
    // «Моё» and the lists refetch; the title itself is already patched.
    void queryClient.invalidateQueries({ queryKey: ["lists", profile, list] });
  }
}

/** Saves (1–10) or removes (null) the profile's rating. Rolls back on failure. */
export async function setRating(mediaId: string, rating: number | null, prev: number | null): Promise<void> {
  const profile = activeProfile.get();
  if (!profile) return;
  patchMeEverywhere(mediaId, { rating });
  const path = { id: profile, mediaId };
  try {
    await unwrap(rating == null ? api.DELETE("/profiles/{id}/ratings/{mediaId}", { params: { path } }) : api.PUT("/profiles/{id}/ratings/{mediaId}", { params: { path }, body: { rating } }));
    // A rating counts as watched in «Подборки»; «Для вас» rebuilds in the background.
    void queryClient.invalidateQueries({ queryKey: ["foryou", "curated"] });
  } catch {
    patchMeEverywhere(mediaId, { rating: prev });
  }
}

/** «Не интересно» (hidden from «Для вас», Surprise and the like). */
export function notInterested(item: MediaSummary, rowId?: string) {
  dismiss(item.id, rowId);
}
