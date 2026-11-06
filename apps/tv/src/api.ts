import { createApi, RealtimeClient, realtimeUrl } from "@martytv/contracts";
import { credentialStore } from "./platform";

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Subscribe to "credential rejected" (device revoked or unknown). */
export function onUnauthorized(l: Listener): () => void {
  unauthorizedListeners.add(l);
  return () => unauthorizedListeners.delete(l);
}

function fireUnauthorized() {
  unauthorizedListeners.forEach((l) => l());
}

export const api = createApi({
  getBearer: () => credentialStore.get() ?? undefined,
  onUnauthorized: fireUnauthorized,
});

/** The TV's realtime link. Authenticates with its device credential. */
export const realtime = new RealtimeClient({
  // auth=token: authenticate as this TV even if the browser has a PWA session cookie.
  url: `${realtimeUrl()}?auth=token`,
  getToken: () => credentialStore.get() ?? undefined,
  onAuthFailed: fireUnauthorized,
});

window.addEventListener("online", () => realtime.reconnectNow());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") realtime.reconnectNow();
});
