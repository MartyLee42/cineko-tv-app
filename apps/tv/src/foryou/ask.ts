// «Спросить ИИ» queries for the TV (helpers: askLogic.ts).
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, unwrap } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { useActiveProfileId } from "../profile/active";
import type { AskKind } from "./askLogic";

export * from "./askLogic";

const useLang = () => catalogLang(useI18n().locale);

export function useAsk() {
  const lang = useLang();
  return useMutation({
    mutationFn: (body: { profile_id: string; prompt: string; kind: AskKind }) =>
      unwrap(api.POST("/foryou/ask", { params: { query: { lang } }, body: { include_watched: false, ...body, lang } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["foryou", "asks"] }),
  });
}

/** The last asks (to reopen). A server without the endpoint → empty. */
export function useAsks() {
  const profile = useActiveProfileId();
  const lang = useLang();
  return useQuery({
    queryKey: ["foryou", "asks", profile, lang],
    enabled: !!profile,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      unwrap(api.GET("/foryou/asks", { params: { query: { profile_id: profile!, lang } } })).catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return { items: [], ai_enabled: true, daily_limit: 0 };
        throw e;
      }),
  });
}
