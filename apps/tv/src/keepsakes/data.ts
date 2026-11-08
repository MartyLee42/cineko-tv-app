// «Моё» keepsakes: the profile's ticket stubs and earned stickers.
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { useActiveProfileId } from "../profile/active";

/** Stubs shown in the «Моё» row (newest first); the whole wall lives in the web app. */
export const TV_TICKETS = 40;

export function useTvTickets() {
  const profile = useActiveProfileId();
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: ["tickets", profile, lang, TV_TICKETS],
    enabled: !!profile,
    staleTime: 60_000,
    retry: false,
    queryFn: () => unwrap(api.GET("/profiles/{id}/tickets", { params: { path: { id: profile! }, query: { lang, limit: TV_TICKETS } } })),
  });
}

// Geometry of the «Моё» keepsakes block (px at 1920×1080), shared by the
// screen (scroll offsets) and the lazy rail.
export const TICKET_FONT = 25;
export const TICKET_W = 560;
/** .ks-ticket is 8.6em tall. */
export const TICKET_H = Math.round(8.6 * TICKET_FONT);
export const KEEP_LABEL = 58;
/** HRow pads its cards by 24 px on each side. */
export const KEEP_RAIL = TICKET_H + 48;
export const KEEP_STICKERS = 280;
export const KEEP_GAP = 36;

/** Height of the block above the watchlist grid (0 = nothing to show). */
export function keepHeight(tickets: boolean, stickers: boolean): number {
  if (!tickets && !stickers) return 0;
  return (tickets ? KEEP_LABEL + KEEP_RAIL : 0) + (stickers ? KEEP_STICKERS : 0) + KEEP_GAP;
}

export function useTvAchievements() {
  const profile = useActiveProfileId();
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: ["achievements", profile, lang],
    enabled: !!profile,
    staleTime: 60_000,
    retry: false,
    queryFn: () => unwrap(api.GET("/profiles/{id}/achievements", { params: { path: { id: profile! }, query: { lang } } })),
  });
}
