// Settings → «Источники»: which sources this profile searches (default: all).
import { useQueryClient } from "@tanstack/react-query";
import { isSourceOn, setSourceOn, type SourcesEnabled } from "@martytv/media-types";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Card, ErrorText } from "../components";
import { AlertIcon } from "../icons";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useProfileSettings, useUpdateSettings } from "../watch/queries";
import { invalidateSearches, useSources, type SourceItem } from "./sourcesApi";

const KIND_KEY: Record<SourceItem["kind"], MessageKey> = {
  torrent: "sources.kind.torrent",
  anime: "sources.kind.anime",
  online: "sources.kind.online",
};

/** Status line under a source's name (null = nothing worth saying). */
export function sourceStatusKey(s: Pick<SourceItem, "available" | "enabled_by_admin" | "needs_credentials" | "configured" | "healthy">): MessageKey | null {
  if (!s.enabled_by_admin) return "sources.settings.disabled_by_admin";
  if (!s.configured) return s.needs_credentials ? "sources.settings.needs_login" : "sources.settings.not_configured";
  if (s.healthy === false) return "sources.settings.unhealthy";
  return null;
}

export function SourcesCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  const settings = useProfileSettings();
  const save = useUpdateSettings();
  const list = useSources(profileId);
  if (!profileId) return null;

  const items = list.data?.items ?? [];
  const enabled: SourcesEnabled = settings.data?.sources?.enabled ?? list.data?.enabled ?? "all";
  const ids = items.map((s) => s.id);
  const noneOn = Array.isArray(enabled) && !items.some((s) => s.available && enabled.includes(s.id));

  const toggle = (id: string, on: boolean) =>
    save.mutate({ sources: { enabled: setSourceOn(enabled, ids, id, on) } }, { onSuccess: () => invalidateSearches(qc) });

  return (
    <Card className="space-y-3">
      <div data-testid="settings-sources">
        <h2 className="text-lg font-bold">{t("sources.settings.title")}</h2>
        <p className="text-xs text-muted">{t("sources.settings.hint")}</p>
      </div>
      {list.isPending ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : (
        <>
          <ErrorText error={list.error} />
          {items.length > 0 && (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {items.map((s) => (
                <SourceRow key={s.id} s={s} on={isSourceOn(enabled, s.id)} onChange={(v) => toggle(s.id, v)} />
              ))}
            </ul>
          )}
        </>
      )}
      {noneOn && (
        <p className="flex gap-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="sources-none-on">
          <AlertIcon className="mt-px shrink-0" />
          {t("sources.settings.none_on")}
        </p>
      )}
      <ErrorText error={save.error} />
      <p className="text-xs leading-relaxed text-muted">{t("sources.settings.help")}</p>
    </Card>
  );
}

function SourceRow({ s, on, onChange }: { s: SourceItem; on: boolean; onChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const status = sourceStatusKey(s);
  const health = s.healthy === true ? "sources.settings.healthy" : s.healthy === false ? "sources.settings.unhealthy" : "sources.settings.unknown";
  const label = `${s.name} · ${t(KIND_KEY[s.kind])}`;
  return (
    <li className="flex items-center gap-3 px-3.5 py-3" data-testid="source-row" data-source-id={s.id}>
      <span
        aria-label={t(health)}
        title={t(health)}
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          !s.available ? "bg-muted/50" : s.healthy === true ? "bg-ok shadow-[0_0_8px] shadow-ok" : s.healthy === false ? "bg-danger" : "bg-muted"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{s.name}</span>
          <span className="text-xs text-muted">{t(KIND_KEY[s.kind])}</span>
        </span>
        {status && (
          <span className={`mt-0.5 block text-xs ${s.available ? "text-accent" : "text-muted"}`} data-testid="source-status">
            {t(status)}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on && s.available}
        aria-label={label}
        disabled={!s.available}
        data-testid={`source-switch-${s.id}`}
        onClick={() => onChange(!on)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${on && s.available ? "bg-accent" : "bg-text/20"}`}
      >
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left] ${on && s.available ? "left-[1.375rem]" : "left-0.5"}`} />
      </button>
    </li>
  );
}
