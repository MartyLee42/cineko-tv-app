// Settings → «Источники» on the TV: one on/off row per source (GET /sources),
// saved as the profile's sources.enabled ("all" while every one is on).
import { useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { isSourceOn, setSourceOn, type SourcesEnabled } from "@martytv/media-types";
import { useI18n, type MessageKey } from "@martytv/ui";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { useSaveSettings } from "../profile/settings";
import { useActiveProfileId } from "../profile/active";
import type { Row } from "./OptionList";

type SourceItem = Schemas["SourceItem"];

const KIND_KEY: Record<SourceItem["kind"], MessageKey> = {
  torrent: "sources.kind.torrent",
  anime: "sources.kind.anime",
  online: "sources.kind.online",
};

export const sourcesKey = (profileId: string | null) => ["sources", profileId] as const;

/** Why a source can't be switched on (null = it can). */
export function unavailableKey(s: Pick<SourceItem, "enabled_by_admin" | "configured" | "needs_credentials">): MessageKey | null {
  if (!s.enabled_by_admin) return "sources.settings.disabled_by_admin";
  if (!s.configured) return s.needs_credentials ? "sources.settings.needs_login" : "sources.settings.not_configured";
  return null;
}

export function useSourceRows(): Row[] {
  const { t } = useI18n();
  const profileId = useActiveProfileId();
  const save = useSaveSettings();
  const q = useQuery({
    queryKey: sourcesKey(profileId),
    enabled: !!profileId,
    queryFn: () => unwrap(api.GET("/sources", { params: { query: { profile_id: profileId! } } })),
    staleTime: 60_000,
  });
  const items = q.data?.items ?? [];
  if (!profileId || items.length === 0) return [];
  const enabled: SourcesEnabled = q.data!.enabled;
  const ids = items.map((s) => s.id);

  const toggle = (id: string, on: boolean) => {
    const next = setSourceOn(enabled, ids, id, on);
    // Optimistic: the rows follow at once; searches made with the old choice are stale.
    queryClient.setQueryData(sourcesKey(profileId), { ...q.data!, enabled: next, items: items.map((s) => ({ ...s, enabled: isSourceOn(next, s.id) })) });
    save.mutate(
      { id: profileId, patch: { sources: { enabled: next } } },
      {
        onSettled: () => {
          void queryClient.invalidateQueries({ queryKey: ["sources"] });
          void queryClient.invalidateQueries({ queryKey: ["releases"] });
          void queryClient.invalidateQueries({ queryKey: ["online"] });
        },
      },
    );
  };

  const rows: Row[] = [{ kind: "header", key: "h-sources", label: t("sources.settings.title"), hint: t("sources.settings.tv_hint") }];
  for (const s of items) {
    const why = unavailableKey(s);
    const health = s.healthy === false ? t("sources.settings.unhealthy") : s.healthy === true ? t("sources.settings.healthy") : t("sources.settings.unknown");
    rows.push({
      kind: "choice",
      key: `source:${s.id}`,
      label: `${s.name} · ${t(KIND_KEY[s.kind])}`,
      hint: why ? t(why) : `${health}. ${t("sources.settings.help")}`,
      choices: why
        ? [{ value: false, label: t(why) }]
        : [
            { value: true, label: t("sources.settings.on") },
            { value: false, label: t("sources.settings.off") },
          ],
      value: !why && isSourceOn(enabled, s.id),
      onChange: (v) => {
        if (!why) toggle(s.id, v as boolean);
      },
    });
  }
  return rows;
}
