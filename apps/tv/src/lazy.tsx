// Code splitting: everything the first screen (pairing / profiles / Home)
// doesn't need loads on demand, in a few chunks (each request costs a lot on
// a high-latency link, so not one per screen). Once Home has shown and the
// TV is idle, prefetchLater() fetches them one by one in the background, so
// later navigation is as instant as before; focusing a menu tab fetches its
// chunk at once. Nothing is prefetched while something plays.
//
// The legacy (SystemJS) build turns these import()s into System.import().
import { lazy, type ComponentType } from "react";
import { getAppliedDesign, Spinner } from "@martytv/ui";
import type { MenuId } from "./design/menuOrder";
import { player } from "./player/controller";
import { live } from "./iptv/live";
import { videoSession } from "./video/session";
import { currentSettings } from "./profile/settings";
import { loaderKind, preloadLoader } from "./player/loaderChunks";
import { retrying } from "./retry";

/** A chunk loader: fetched once, retried on a network hiccup, retried again later after a failure. */
const chunk = retrying;

const details = chunk(() => import("./screens/catalog/DetailsScreen"));
const catalog = chunk(() => import("./screens/catalog/chunkCatalog"));
const media = chunk(() => import("./screens/catalog/chunkMedia"));
const settings = chunk(() => import("./settings/chunkSettings"));
const playback = chunk(() => {
  // The profile's loading style travels with the player (it's the first thing the player shows).
  const s = currentSettings();
  // The applied design (a «Сюрприз» may differ from settings.design), as Loader.tsx picks it.
  void preloadLoader(loaderKind(s.loading_style, getAppliedDesign() ?? s.design)).catch(() => undefined);
  return import("./player/chunkPlayback");
});

/** React.lazy over a named export of a chunk. */
function from<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the caller gets the export's own type back
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType<any> }))) as unknown as M[K];
}

export const DetailsScreen = from(details, "DetailsScreen");

export const SearchScreen = from(catalog, "SearchScreen");
export const BrowseScreen = from(catalog, "BrowseScreen");
export const MineScreen = from(catalog, "MineScreen");
export const MessagesScreen = from(catalog, "MessagesScreen");
export const ExploreScreen = from(catalog, "ExploreScreen");
export const TileScreen = from(catalog, "TileScreen");
export const CollectionScreen = from(catalog, "CollectionScreen");
export const CuratedScreen = from(catalog, "CuratedScreen");
export const PersonScreen = from(catalog, "PersonScreen");
export const HistoryScreen = from(catalog, "HistoryScreen");
export const NewEpisodesScreen = from(catalog, "NewEpisodesScreen");
export const SurpriseScreen = from(catalog, "SurpriseScreen");
export const AskScreen = from(catalog, "AskScreen");

export const TvChannelsScreen = from(media, "TvChannelsScreen");
export const TvDayScreen = from(media, "TvDayScreen");
export const VideoScreen = from(media, "VideoScreen");
export const VideoSearchScreen = from(media, "VideoSearchScreen");
export const VideoChannelScreen = from(media, "VideoChannelScreen");

export const SettingsScreen = from(settings, "SettingsScreen");
export const Onboarding = from(settings, "Onboarding");
export const TasteQuiz = from(settings, "TasteQuiz");

export const PlayerLayer = from(playback, "PlayerLayer");
export const LivePlayer = from(playback, "LivePlayer");
export const VideoPlayer = from(playback, "VideoPlayer");


/** While a screen's chunk loads: the spinner fades in only if it takes a while (no flash when prefetched). */
export function ScreenWait() {
  return (
    <div data-testid="lazy-wait" className="flex h-full w-full items-center justify-center">
      <span className="tv-lazy-wait">
        <Spinner size={56} />
      </span>
    </div>
  );
}

/** While the player chunk loads: the player's dark backdrop and a (late) spinner. */
export function PlayerWait() {
  return (
    <div data-testid="lazy-wait" className="absolute left-0 top-0 flex h-full w-full items-center justify-center bg-black">
      <span className="tv-lazy-wait">
        <Spinner size={56} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- prefetch

/** Most likely next first: Details (OK on a card), the player, then the menu sections. */
const QUEUE = [details, playback, catalog, media, settings];

const playing = () => player.flow.phase !== "idle" || live.active() || videoSession.active();

function whenIdle(fn: () => void) {
  // Old TV engines (Chrome < 47, Safari) have no requestIdleCallback.
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout: 3000 });
  else setTimeout(fn, 50);
}

let scheduled = false;

/** After startup (Home shown): fetch every chunk in the background, one at a time, never during playback. */
export function prefetchLater(delay = 5000) {
  if (scheduled) return;
  scheduled = true;
  let i = 0;
  const step = () => {
    if (i >= QUEUE.length) return;
    // Playback owns the CPU and the link: try again later.
    if (playing()) return void setTimeout(step, 15_000);
    const load = QUEUE[i++]!;
    void load()
      .catch(() => undefined)
      .then(() => setTimeout(() => whenIdle(step), 250));
  };
  setTimeout(() => whenIdle(step), delay);
}

const byMenu: Partial<Record<MenuId, () => Promise<unknown>>> = {
  search: catalog,
  explore: catalog,
  movies: catalog,
  series: catalog,
  surprise: catalog,
  ask: catalog,
  history: catalog,
  new: catalog,
  mine: catalog,
  messages: catalog,
  tv: media,
  video: media,
  settings,
};

/** A menu tab got focus: fetch its chunk now (no-op once loaded). */
export function prefetchMenu(id: string) {
  if (playing()) return;
  const load = byMenu[id as MenuId];
  if (load) void load().catch(() => undefined);
}

/** Opening Details soon (a card focused): fetch it now. */
export function prefetchDetails() {
  if (!playing()) void details().catch(() => undefined);
}
