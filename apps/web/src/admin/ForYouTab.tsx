import { useEffect, useState } from "react";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Button, Card, ErrorText, Field, Input, Select, timeAgo } from "../components";
import { useProfiles } from "../queries";
import { useAdminUsers } from "../pages/AdminPage";
import { ProgressBar } from "../watch/components";
import { anyRunning, runProgress } from "../foryou/logic";
import { useForYouRuns, useRerun, useSetAITemperature, type AITemperature, type ForYouRun, type RerunBody } from "../foryou/queries";
import { balanceLow, formatBalance, type AIBalance } from "../foryou/taste";

type Scope = RerunBody["scope"];
const OTHER = "__other__";

/** Admin → «Рекомендации»: recompute now (scope + AI toggle) and the recent runs with live progress. */
export function ForYouTab() {
  const { t, locale } = useI18n();
  const [scope, setScope] = useState<Scope>("all");
  const [userId, setUserId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [otherId, setOtherId] = useState("");
  const [ai, setAi] = useState(true);
  const users = useAdminUsers();
  const profiles = useProfiles();
  const rerun = useRerun();
  // Poll fast while a run is going (and briefly after starting one, until it shows up).
  const [kicked, setKicked] = useState(false);
  const [lastRunning, setLastRunning] = useState(false);
  const runs = useForYouRuns(kicked || lastRunning);
  const running = anyRunning(runs.data?.items);
  if (running !== lastRunning) setLastRunning(running);
  useEffect(() => {
    if (!kicked) return;
    const id = setTimeout(() => setKicked(false), 10_000);
    return () => clearTimeout(id);
  }, [kicked]);

  const aiEnabled = runs.data?.ai.enabled ?? true;
  const target = scope === "user" ? userId : scope === "profile" ? (profileId === OTHER ? otherId.trim() : profileId) : "";
  const canRun = scope === "all" || /^[0-9a-f-]{36}$/i.test(target);
  const names = new Map<string, string>();
  for (const u of users.data ?? []) names.set(u.id, u.display_name || u.username);
  for (const p of profiles.data ?? []) names.set(p.id, p.name);

  const ai$ = runs.data?.ai;
  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div>
          <h2 className="font-semibold">{t("fy.admin.tab")}</h2>
          {runs.data && (
            <p className="mt-0.5 text-xs text-muted" data-testid="foryou-schedule">
              {runs.data.daily_at === "off" ? t("fy.admin.daily_off") : t("fy.admin.daily_at", { time: runs.data.daily_at })}
              {runs.data.next_run_at && ` · ${t("fy.admin.next_run", { time: new Date(runs.data.next_run_at).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) })}`}
              {ai$ && ` · ${t("fy.admin.budget", { used: ai$.tokens_today.toLocaleString(locale), budget: ai$.daily_budget.toLocaleString(locale), model: ai$.model })}`}
            </p>
          )}
          {ai$?.enabled && <BalanceLine balance={ai$.balance} />}
        </div>
        <form
          className="space-y-3"
          data-testid="foryou-rerun-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canRun) return;
            rerun.mutate({ scope, ai: ai && aiEnabled, ...(scope !== "all" && { id: target }) }, { onSuccess: () => setKicked(true) });
          }}
        >
          <div role="radiogroup" aria-label={t("fy.admin.scope")} className="inline-flex rounded-full border border-border bg-bg p-1">
            {(["all", "user", "profile"] as Scope[]).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                data-scope={s}
                onClick={() => setScope(s)}
                className={`min-h-[36px] rounded-full px-4 text-sm font-medium transition ${scope === s ? "bg-accent text-on-accent" : "text-muted hover:text-text"}`}
              >
                {t(`fy.admin.scope_${s}` as MessageKey)}
              </button>
            ))}
          </div>
          {scope === "user" && (
            <Field label={t("fy.admin.pick_user")}>
              <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="sm:w-80" data-testid="foryou-user">
                <option value="">—</option>
                {(users.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name || u.username}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {scope === "profile" && (
            <div className="flex flex-col gap-3 sm:flex-row">
              <Field label={t("fy.admin.pick_profile")}>
                <Select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="sm:w-64" data-testid="foryou-profile">
                  <option value="">—</option>
                  {(profiles.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value={OTHER}>ID…</option>
                </Select>
              </Field>
              {profileId === OTHER && (
                <Field label="ID">
                  <Input value={otherId} onChange={(e) => setOtherId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-sm sm:w-96" />
                </Field>
              )}
            </div>
          )}
          <label className={`flex items-start gap-2 text-sm ${aiEnabled ? "" : "opacity-60"}`}>
            <input type="checkbox" className="mt-1" checked={ai && aiEnabled} disabled={!aiEnabled} onChange={(e) => setAi(e.target.checked)} data-testid="foryou-ai" />
            <span>
              <span className="font-medium">{t("fy.admin.ai")}</span>
              <span className="block text-xs text-muted">{aiEnabled ? t("fy.admin.ai_hint") : t("fy.admin.ai_disabled")}</span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" busy={rerun.isPending} disabled={!canRun || running} data-testid="foryou-rerun">
              {running && <Spinner size={16} />}
              {t("fy.admin.rerun")}
            </Button>
            {rerun.data?.already && (
              <p role="status" className="text-sm font-medium text-warn" data-testid="foryou-already">
                {t("fy.admin.already_running")}
              </p>
            )}
            {rerun.data && !rerun.data.already && !running && <p className="text-sm text-ok">{t("fy.admin.started")}</p>}
          </div>
          <ErrorText error={rerun.error} />
        </form>
      </Card>

      {ai$?.enabled && ai$.temperature && <TemperatureCard current={ai$.temperature} />}

      <Card className="space-y-3">
        <h2 className="font-semibold">{t("fy.admin.runs")}</h2>
        <ErrorText error={runs.error} />
        {runs.isPending ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : !runs.data?.items.length ? (
          <p className="text-sm text-muted">{t("fy.admin.no_runs")}</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="foryou-runs">
            {runs.data.items.map((r) => (
              <RunRow key={r.id} r={r} target={r.target_id ? (names.get(r.target_id) ?? r.target_id.slice(0, 8)) : null} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const STATUS_CLS: Record<ForYouRun["status"], string> = {
  running: "bg-accent/15 text-text",
  completed: "bg-ok/15 text-ok",
  failed: "bg-danger/15 text-danger",
};

function RunRow({ r, target }: { r: ForYouRun; target: string | null }) {
  const { t, locale } = useI18n();
  const p = runProgress(r);
  return (
    <li className="space-y-1.5 py-3 text-sm" data-testid="foryou-run" data-status={r.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold ${STATUS_CLS[r.status]}`}>
          {r.status === "running" && <Spinner size={10} />}
          {t(`fy.admin.status.${r.status}` as MessageKey)}
        </span>
        <span className="font-medium">
          {t(`fy.admin.scope_${r.scope}` as MessageKey)}
          {target && `: ${target}`}
        </span>
        <span className="text-xs text-muted">
          {[t(`fy.admin.trigger.${r.trigger}` as MessageKey), r.ai ? t("fy.admin.with_ai") : null, r.requested_by ? t("fy.admin.by", { name: r.requested_by.username }) : null].filter(Boolean).join(" · ")}
        </span>
        <span className="ml-auto text-xs text-muted" title={new Date(r.started_at).toLocaleString(locale)}>
          {timeAgo(r.started_at, locale)}
          {r.duration_ms != null && ` · ${t("fy.admin.duration", { s: (r.duration_ms / 1000).toFixed(1) })}`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <ProgressBar value={p} className="max-w-xs flex-1" />
        <span className="shrink-0 text-xs tabular-nums text-muted" data-testid="foryou-run-progress">
          {t("fy.admin.progress", { done: r.profiles_done, total: r.profiles_total })}
        </span>
      </div>
      <p className="text-xs text-muted">
        {[t("fy.admin.tokens", { n: r.ai_tokens.toLocaleString(locale) }), t("fy.admin.ai_calls", { n: r.ai_calls }), t("fy.admin.collections", { n: r.collections_created })].join(" · ")}
      </p>
      {r.errors.length > 0 && (
        <details className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          <summary className="cursor-pointer font-semibold">{t("fy.admin.errors", { n: r.errors.length })}</summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {r.errors.map((e, i) => (
              <li key={i} className="break-words">
                [{e.step}] {e.profile_id ? `${e.profile_id.slice(0, 8)}: ` : ""}
                {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** «Баланс DeepSeek: $9.53» next to the token budget; warning tone when low or unavailable. */
function BalanceLine({ balance }: { balance: AIBalance | null | undefined }) {
  const { t, locale } = useI18n();
  if (!balance) {
    return (
      <p className="mt-0.5 text-xs text-muted" data-testid="foryou-balance">
        {t("taste.admin.balance_unknown")}
      </p>
    );
  }
  const low = balanceLow(balance);
  return (
    <p data-testid="foryou-balance" data-low={low || undefined} className={`mt-0.5 text-xs ${low ? "font-semibold text-warn" : "text-muted"}`}>
      {low && "⚠ "}
      {t("taste.admin.balance", { amount: formatBalance(balance, locale) })}
      {!balance.available ? ` · ${t("taste.admin.balance_unavailable")}` : low ? ` · ${t("taste.admin.balance_low")}` : ""}
    </p>
  );
}

const TEMP_KEYS: (keyof AITemperature)[] = ["collections", "ask", "music", "facts"];

/** DeepSeek temperature per feature (0–1.5); viewers nudge it with «Точнее / Смелее». */
function TemperatureCard({ current }: { current: AITemperature }) {
  const { t, locale } = useI18n();
  const save = useSetAITemperature();
  const [draft, setDraft] = useState<AITemperature>(current);
  const [saved, setSaved] = useState(false);
  const changed = TEMP_KEYS.some((k) => draft[k] !== current[k]);
  const fmt = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return (
    <Card className="space-y-3">
      <div data-testid="foryou-temperature">
        <h2 className="font-semibold">{t("fy.admin.temp")}</h2>
        <p className="mt-0.5 text-xs text-muted">{t("fy.admin.temp_hint")}</p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate(draft, { onSuccess: () => setSaved(true) });
        }}
      >
        {TEMP_KEYS.map((k) => (
          <label key={k} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-52 font-medium">{t(`fy.admin.temp.${k}` as MessageKey)}</span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={draft[k]}
              onChange={(e) => {
                setSaved(false);
                setDraft({ ...draft, [k]: Number(e.target.value) });
              }}
              className="w-56 accent-[rgb(var(--mt-accent))]"
              data-testid={`foryou-temp-${k}`}
            />
            <span className="w-10 tabular-nums text-muted">{fmt(draft[k])}</span>
          </label>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" busy={save.isPending} disabled={!changed} data-testid="foryou-temp-save">
            {t("fy.admin.temp_save")}
          </Button>
          <button
            type="button"
            className="text-sm text-muted underline-offset-2 hover:text-text hover:underline"
            onClick={() => {
              setSaved(false);
              setDraft({ collections: 1, ask: 1, music: 1, facts: 0.7 });
            }}
          >
            {t("fy.admin.temp_reset")}
          </button>
          {saved && !changed && <p className="text-sm text-ok">{t("fy.admin.temp_saved")}</p>}
        </div>
        <ErrorText error={save.error} />
      </form>
    </Card>
  );
}
