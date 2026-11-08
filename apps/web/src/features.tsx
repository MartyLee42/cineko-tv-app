// What this server has (GET /status `features`, install.sh options), shared
// with every other /status reader (one query). All on until known.
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { serverFeatures, type ServerFeatures } from "@martytv/ui";
import { api } from "./api";

export function useServerFeatures(): ServerFeatures {
  const q = useQuery({ queryKey: ["service-status"], queryFn: () => unwrap(api.GET("/status")), staleTime: 60_000, refetchInterval: 5 * 60_000, retry: false });
  return serverFeatures(q.data);
}

/** A menu tab this server has: «Видео» needs YouTube. */
export function tabAvailable(tab: string | undefined, f: ServerFeatures): boolean {
  return !(tab === "video" && !f.video);
}

/** «Видео» pages: Home when the server has no YouTube. */
export function VideoGate({ children }: { children: ReactNode }) {
  return useServerFeatures().video ? <>{children}</> : <Navigate to="/" replace />;
}
