// Admin → Sources: switch a source on/off for everyone, override its base
// URL, store an API key (write-only) and run the health check.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { api } from "../api";
import { Button, Card, ErrorText, Input, timeAgo } from "../components";
import { CheckIcon, RefreshIcon } from "../icons";
import { invalidateSearches, type AdminSource } from "../play/sourcesApi";

const KIND_KEY: Record<AdminSource["kind"], MessageKey> = {
  torrent: "sources.kind.torrent",
  anime: "sources.kind.anime",
  online: "sources.kind.online",
};

const adminKey = ["admin", "sources"] as const;

type Patch = { enabled?: boolean; base_url?: string; credentials?: Record<string, string> };

/**
 * What the admin can change per source (what its provider reads): Jacred a
 * base URL and an API key, AniLiberty a base URL, Prowlarr nothing (env
 * only). Sources added later: a URL, and a key when they need credentials.
 */
const SETTINGS: Record<string, { url: boolean; key: boolean }> = {
  prowlarr: { url: false, key: false },
  jacred: { url: true, key: true },
  anilibria: { url: true, key: false },
};

export function adminFields(s: Pick<AdminSource, "id" | "needs_credentials" | "has_credentials">): { url: boolean; key: boolean } {
  const known = SETTINGS[s.id] ?? { url: true, key: s.needs_credentials };
  return { url: known.url, key: known.key || s.has_credentials };
}

export function SourcesTab() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: adminKey, queryFn: async () => (await unwrap(api.GET("/admin/sources"))).items });
  if (q.isPending) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="admin-sources">
      <p className="text-sm text-muted">{t("sources.admin.hint")}</p>
      <ErrorText error={q.error} />
      {q.data?.length === 0 && <p className="text-sm text-muted">{t("sources.admin.empty")}</p>}
      {q.data?.map((s) => <SourceCard key={s.id} s={s} />)}
    </div>
  );
}

function SourceCard({ s }: { s: AdminSource }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  // null = untouched (shows the saved value).
  const [draft, setDraft] = useState<string | null>(null);
  const baseUrl = draft ?? s.base_url;
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(0), 2500);
    return () => clearTimeout(id);
  }, [saved]);

  const put = (fresh: AdminSource) => qc.setQueryData<AdminSource[]>(adminKey, (cur) => cur?.map((x) => (x.id === fresh.id ? fresh : x)));
  const patch = useMutation({
    mutationFn: (body: Patch) => unwrap(api.PATCH("/admin/sources/{id}", { params: { path: { id: s.id } }, body })),
    onSuccess: (fresh, body) => {
      put(fresh);
      setSaved(Date.now());
      if (body.credentials) setKey("");
      if (body.base_url !== undefined) setDraft(null);
      invalidateSearches(qc);
    },
  });
  const probe = useMutation({
    mutationFn: () => unwrap(api.POST("/admin/sources/{id}/probe", { params: { path: { id: s.id } } })),
    onSuccess: put,
  });

  const health = s.healthy === true ? "sources.settings.healthy" : s.healthy === false ? "sources.settings.unhealthy" : "sources.settings.unknown";
  const dirtyUrl = baseUrl.trim() !== s.base_url;
  const fields = adminFields(s);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="admin-source" data-source-id={s.id}>
        <span
          aria-hidden
          className={`h-3 w-3 shrink-0 rounded-full ${s.healthy === true ? "bg-ok shadow-[0_0_8px] shadow-ok" : s.healthy === false ? "bg-danger" : "bg-muted"}`}
        />
        <div className="min-w-[12rem] flex-1">
          <h2 className="font-semibold">
            {s.name} <span className="text-xs font-normal text-muted">· {t(KIND_KEY[s.kind])} · {s.id}</span>
          </h2>
          <p className="text-xs text-muted" data-testid="admin-source-health">
            {t(health)} · {s.checked_at ? t("sources.admin.checked", { when: timeAgo(s.checked_at, locale) }) : t("sources.admin.never_checked")}
            {!s.configured && <span className="text-accent"> · {s.needs_credentials ? t("sources.admin.needs_credentials") : t("sources.settings.not_configured")}</span>}
          </p>
        </div>
        <span className="flex w-full items-center justify-end gap-3 sm:w-auto">
        <span
          aria-live="polite"
          className={`flex items-center gap-1 text-xs font-semibold text-ok transition-opacity ${saved ? "opacity-100" : "opacity-0"}`}
          data-testid="admin-source-saved"
        >
          {saved ? (
            <>
              <CheckIcon /> {t("sources.admin.saved")}
            </>
          ) : null}
        </span>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">{t("sources.admin.enabled")}</span>
          <button
            type="button"
            role="switch"
            aria-checked={s.enabled_by_admin}
            aria-label={`${s.name}: ${t("sources.admin.enabled")}`}
            data-testid="admin-source-enabled"
            disabled={patch.isPending}
            onClick={() => patch.mutate({ enabled: !s.enabled_by_admin })}
            className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-60 ${s.enabled_by_admin ? "bg-accent" : "bg-text/20"}`}
          >
            <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left] ${s.enabled_by_admin ? "left-[1.375rem]" : "left-0.5"}`} />
          </button>
        </label>
        </span>
      </div>

      {s.last_error && (
        <p className="break-words rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger [overflow-wrap:anywhere]" data-testid="admin-source-error">
          {t("sources.admin.last_error", { error: s.last_error })}
        </p>
      )}

      {!fields.url && !fields.key && <p className="text-sm text-muted">{t("sources.admin.env_only")}</p>}

      {fields.url && (
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          patch.mutate({ base_url: baseUrl.trim() });
        }}
      >
        <label className="text-sm text-muted" htmlFor={`src-url-${s.id}`}>
          {t("sources.admin.base_url")}
        </label>
        <div className="flex gap-2">
          <Input
            id={`src-url-${s.id}`}
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={baseUrl}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="admin-source-url"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary" disabled={!dirtyUrl || patch.isPending}>
            {t("sources.admin.save")}
          </Button>
        </div>
        <p className="text-xs text-muted">{t("sources.admin.base_url_hint")}</p>
      </form>
      )}

      {fields.key && (
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) patch.mutate({ credentials: { apikey: key.trim() } });
          }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <label className="text-sm text-muted" htmlFor={`src-key-${s.id}`}>
              {t("sources.admin.credentials")}
            </label>
            <span className={`text-xs font-semibold ${s.has_credentials ? "text-ok" : "text-muted"}`} data-testid="admin-source-key-state">
              {s.has_credentials ? t("sources.admin.credentials_saved") : t("sources.admin.credentials_none")}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              id={`src-key-${s.id}`}
              type="password"
              autoComplete="off"
              placeholder={s.has_credentials ? "••••••••" : ""}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              data-testid="admin-source-key"
              className="min-w-0 flex-1 basis-full sm:basis-0"
            />
            <Button type="submit" variant="secondary" disabled={!key.trim() || patch.isPending}>
              {t("sources.admin.save")}
            </Button>
            {s.has_credentials && (
              <Button type="button" variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ credentials: {} })}>
                {t("sources.admin.clear_credentials")}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">{t("sources.admin.credentials_hint")}</p>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button variant="secondary" onClick={() => probe.mutate()} disabled={probe.isPending} data-testid="admin-source-probe">
          {probe.isPending ? <Spinner size={16} /> : <RefreshIcon />}
          {t("sources.admin.probe")}
        </Button>
        {probe.isSuccess && (
          <span className={`text-sm font-semibold ${probe.data.healthy ? "text-ok" : "text-danger"}`} data-testid="admin-source-probe-result">
            {t(probe.data.healthy ? "sources.settings.healthy" : "sources.settings.unhealthy")}
          </span>
        )}
      </div>
      <ErrorText error={patch.error ?? probe.error} />
    </Card>
  );
}
