import { useSyncExternalStore } from "react";
import { player } from "./controller";
import type { Flow } from "./session";

const subscribeFlow = (cb: () => void) => player.subscribe((k) => k === "flow" && cb());
const getFlow = () => player.flow;

/** The flow state (re-renders on every flow change). Kept apart from PlayerLayer, which loads lazily. */
export function useFlow(): Flow {
  return useSyncExternalStore(subscribeFlow, getFlow);
}
