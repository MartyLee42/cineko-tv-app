import { preloadLocale } from "@martytv/ui/locale-preload";
import { tabletRedirect } from "./tablet";
import { preloadSavedLook } from "./design/looks/registry";
import { seedNewTvDesign } from "./design/newTv";
import { watched } from "./chunkReload";

// iPad gets the touch web app; everything else boots the TV app.
const to = tabletRedirect(location, navigator.userAgent, navigator.maxTouchPoints ?? 0, "ontouchend" in document, sessionStorage);
if (to) location.replace(to);
else {
  // The start language's strings (a chunk of their own) travel next to the app.
  preloadLocale();
  // …and so does the saved design's own chunk (its CSS and drawings: design/looks);
  // a fresh, unpaired TV starts in «Каркас» (design/newTv).
  seedNewTvDesign();
  preloadSavedLook();
  // A release replaced while this page loaded: reload once (chunkReload.ts).
  void watched(import("./boot")).catch(() => undefined);
}
