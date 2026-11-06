// Settings → «Импорт оценок с Кинопоиска»: upload a Kinopoisk ratings CSV,
// follow the background job, then review what could not be matched.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { useI18n, type MessageKey } from "@martytv/ui";
import { api } from "../api";
import { Button, Card, ErrorText } from "../components";
import { useActiveProfile } from "../watch/ActiveProfile";

type ImportJob = Schemas["ImportJob"];
type Reason = Schemas["ImportUnmatched"]["reason"];

const MAX_BYTES = 5 * 1024 * 1024;

const REASON_KEY: Record<Reason, MessageKey> = {
  not_found: "imports.kp.reason.not_found",
  ambiguous: "imports.kp.reason.ambiguous",
  invalid_row: "imports.kp.reason.invalid_row",
  tmdb_error: "imports.kp.reason.tmdb_error",
  kp_conflict: "imports.kp.reason.kp_conflict",
};

const active = (j: ImportJob | null | undefined) => j?.status === "queued" || j?.status === "running";

/** The profile's latest import (null when it never imported). Polls while it runs. */
function useLatestImport(profileId: string | undefined) {
  return useQuery({
    queryKey: ["imports", "kinopoisk", profileId],
    enabled: !!profileId,
    queryFn: async () => {
      try {
        return await unwrap(api.GET("/profiles/{id}/imports/kinopoisk", { params: { path: { id: profileId! } } }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    refetchInterval: (q) => (active(q.state.data) ? 1500 : false),
  });
}

export function KinopoiskImportCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { profile, profileId } = useActiveProfile();
  const latest = useLatestImport(profileId);
  const [file, setFile] = useState<File | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [markWatched, setMarkWatched] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const start = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file!);
      form.append("overwrite", String(overwrite));
      form.append("mark_watched", String(markWatched));
      return unwrap(
        api.POST("/profiles/{id}/imports/kinopoisk", {
          params: { path: { id: profileId! } },
          // FormData passes through openapi-fetch untouched (the browser sets the boundary).
          body: form as unknown as { file: string },
        }),
      );
    },
    onSuccess: () => {
      setShowForm(false);
      setFile(null);
      if (input.current) input.current.value = "";
      void qc.invalidateQueries({ queryKey: ["imports", "kinopoisk", profileId] });
    },
  });

  // When a job finishes, ratings and "watched" marks changed everywhere.
  const job = latest.data;
  const wasActive = useRef(false);
  useEffect(() => {
    if (active(job)) wasActive.current = true;
    else if (wasActive.current && job) {
      wasActive.current = false;
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "imports" });
    }
  }, [job, qc]);

  if (!profileId || !profile) return null;
  const tooBig = !!file && file.size > MAX_BYTES;
  const formVisible = !job || showForm;

  return (
    <Card className="space-y-3">
      <div data-testid="settings-kp-import">
        <h2 className="text-lg font-bold">{t("imports.kp.title")}</h2>
        <p className="text-xs text-muted">{t("imports.kp.hint", { name: profile.name })}</p>
      </div>

      {job && active(job) && <Progress job={job} />}
      {job && !active(job) && !showForm && <Summary job={job} onAgain={() => setShowForm(true)} />}

      {formVisible && !active(job) && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (file && !tooBig) start.mutate();
          }}
        >
          <details className="rounded-xl border border-border px-3.5 py-2 text-sm">
            <summary className="cursor-pointer font-medium">{t("imports.kp.how_title")}</summary>
            <p className="mt-2 text-xs leading-relaxed text-muted">{t("imports.kp.how")}</p>
          </details>
          <label className="flex flex-wrap items-center gap-3">
            <span className="sr-only">{t("imports.kp.file")}</span>
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv"
              data-testid="kp-import-file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:min-h-[40px] file:rounded-xl file:border-0 file:bg-surface-2 file:px-4 file:font-semibold file:text-text hover:file:bg-border"
            />
          </label>
          {tooBig && <p className="text-sm text-danger">{t("imports.kp.too_big")}</p>}
          <div className="divide-y divide-border rounded-xl border border-border">
            <Check label={t("imports.kp.overwrite")} hint={t("imports.kp.overwrite_hint")} on={overwrite} onChange={setOverwrite} testId="kp-import-overwrite" />
            <Check
              label={t("imports.kp.mark_watched")}
              hint={t("imports.kp.mark_watched_hint")}
              on={markWatched}
              onChange={setMarkWatched}
              testId="kp-import-watched"
            />
          </div>
          <ErrorText error={start.error} />
          <Button type="submit" busy={start.isPending} disabled={!file || tooBig} data-testid="kp-import-start">
            {t("imports.kp.start")}
          </Button>
        </form>
      )}
      <ErrorText error={latest.error} />
    </Card>
  );
}

function Check({ label, hint, on, onChange, testId }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--mt-accent))]"
      />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}

function Progress({ job }: { job: ImportJob }) {
  const { t } = useI18n();
  const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  return (
    <div className="space-y-2" data-testid="kp-import-progress">
      <p className="text-sm font-medium" aria-live="polite">
        {job.status === "queued" ? t("imports.kp.queued") : t("imports.kp.running", { done: job.processed, total: job.total })}
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full bg-text/10"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Summary({ job, onAgain }: { job: ImportJob; onAgain: () => void }) {
  const { t } = useI18n();
  const stats: [MessageKey, number, string][] = [
    ["imports.kp.stat_total", job.total, "total"],
    ["imports.kp.stat_matched", job.matched, "matched"],
    ["imports.kp.stat_rated", job.rated, "rated"],
    ["imports.kp.stat_skipped", job.skipped, "skipped"],
  ];
  return (
    <div className="space-y-3" data-testid="kp-import-summary">
      <p className={`text-sm font-semibold ${job.status === "failed" ? "text-danger" : "text-ok"}`} role="status">
        {job.status === "failed" ? t("imports.kp.failed") : t("imports.kp.done", { rated: job.rated })}
      </p>
      {job.dry_run && <p className="text-xs text-muted">{t("imports.kp.dry_run")}</p>}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map(([key, n, id]) => (
          <div key={id} className="rounded-xl bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">{t(key)}</dt>
            <dd className="text-lg font-bold tabular-nums" data-testid={`kp-import-${id}`}>
              {n}
            </dd>
          </div>
        ))}
      </dl>
      {job.unmatched.length > 0 && (
        <details className="rounded-xl border border-border" data-testid="kp-import-unmatched">
          <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium">
            {t("imports.kp.unmatched", { n: job.unmatched.length })}
          </summary>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto border-t border-border text-sm">
            {job.unmatched.map((u, i) => (
              <li key={`${u.kp_id}-${i}`} className="flex items-center gap-3 px-3.5 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {u.title}
                    {u.year != null && <span className="text-muted"> ({u.year})</span>}
                  </span>
                  <span className="block text-xs text-muted">{t(REASON_KEY[u.reason])}</span>
                </span>
                {u.title && u.reason !== "invalid_row" && (
                  <Link to={`/search?q=${encodeURIComponent(u.title)}`} className="shrink-0 text-xs font-semibold text-accent hover:underline">
                    {t("imports.kp.find")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Button type="button" variant="secondary" onClick={onAgain} data-testid="kp-import-again">
        {t("imports.kp.again")}
      </Button>
    </div>
  );
}
