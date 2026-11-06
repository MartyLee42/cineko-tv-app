import { QueryClient } from "@tanstack/react-query";
import { ApiError, createApi, RealtimeClient, realtimeUrl } from "@martytv/contracts";

let csrfToken: string | undefined;

export function setCsrfToken(t: string | undefined) {
  csrfToken = t;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
  },
});

export const api = createApi({
  getCsrfToken: () => csrfToken,
  onUnauthorized: () => {
    setCsrfToken(undefined);
    queryClient.setQueryData(["session"], null);
  },
});

/** One realtime connection per signed-in browser tab (cookie-authenticated). */
export const realtime = new RealtimeClient({ url: realtimeUrl() });

if (typeof window !== "undefined") {
  window.addEventListener("online", () => realtime.reconnectNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") realtime.reconnectNow();
  });
}
