import { preloadLocale } from "@martytv/ui/locale-preload";
import { tabletRedirect } from "./tablet";

// iPad gets the touch web app; everything else boots the TV app.
const to = tabletRedirect(location, navigator.userAgent, navigator.maxTouchPoints ?? 0, "ontouchend" in document, sessionStorage);
if (to) location.replace(to);
else {
  // The start language's strings (a chunk of their own) travel next to the app.
  preloadLocale();
  void import("./boot");
}
