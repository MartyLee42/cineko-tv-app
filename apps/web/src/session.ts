import { useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { api, setCsrfToken } from "./api";

export type Session = Schemas["Session"];

/** The signed-in principal, or null when signed out. */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async (): Promise<Session | null> => {
      try {
        const s = await unwrap(api.GET("/auth/session"));
        setCsrfToken(s.csrf_token);
        return s;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    // Offline: show the offline screen at once instead of retrying.
    retry: (count, err) =>
      (typeof navigator === "undefined" || navigator.onLine) && !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
  });
}
