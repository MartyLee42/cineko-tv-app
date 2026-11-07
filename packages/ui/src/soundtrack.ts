// «Послушать саундтрек»: Cineko Music builds (or reuses) the account's
// playlist of a title's music at /music/soundtrack/<id> and then opens it.
import type { Locale } from "./localeDetect";

/** The Cineko Music page that makes the title's soundtrack playlist. origin "" = same site. */
export function soundtrackUrl(origin: string, mediaId: string, locale: Locale): string {
  return `${origin.replace(/\/+$/, "")}/music/soundtrack/${encodeURIComponent(mediaId)}?lang=${locale}`;
}
