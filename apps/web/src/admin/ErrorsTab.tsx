import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { api, realtime } from "../api";
import { Button, Card, ErrorText, Input, Select, timeAgo } from "../components";
import { Sheet } from "../remote/SendToTv";
import {
  copyText,
  ERROR_APPS,
  ERROR_KINDS,
  groupAsText,
  isNewGroup,
  readLastViewed,
  sinceFor,
  TIME_RANGES,
  writeLastViewed,
  type ErrorApp,
  type ErrorGroup,
  type ErrorKind,
  type ErrorSample,
  type TimeRange,
} from "./errors";

const PAGE = 50;
const LIST_KEY = ["admin", "client-errors"] as const;

const APP_BADGE: Record<ErrorApp, string> = {
  web: "bg-accent/15 text-accent",
  tv: "bg-ok/15 text-ok",
  api: "bg-warn/15 text-warn",
};

type Status = "unresolved" | "resolved" | "all";
type Sort = "last_seen" | "count";

interface Filters {
  app: ErrorApp | "";
  kind: ErrorKind | "";
  status: Status;
  range: TimeRange;
  q: string;
  sort: Sort;
  /** User id ("" = everyone). */
  user: string;
}

/** Unresolved groups seen since the admin last opened the Errors tab (the
 * tab badge). Refreshes every minute and on realtime `client_error.new`. */
export function useUnseenErrors(onTab: boolean): number {
  const qc = useQueryClient();
  // Mark the tab viewed when it opens and again when the admin leaves it, so
  // groups seen while it was open don't count as unseen afterwards.
  useEffect(() => {
    if (!onTab) return;
    writeLastViewed(new Date().toISOString());
    return () => writeLastViewed(new Date().toISOString());
  }, [onTab]);
  const since = onTab ? null : readLastViewed();
  useEffect(
    () =>
      realtime.on((env) => {
        if (env.type === "client_error.new") void qc.invalidateQueries({ queryKey: LIST_KEY });
      }),
    [qc],
  );
  const q = useQuery({
    queryKey: [...LIST_KEY, "unseen", since],
    queryFn: async () =>
      (
        await unwrap(
          api.GET("/admin/client-errors", {
            params: { query: { status: "unresolved", limit: 1, ...(since ? { since } : {}) } },
          }),
        )
      ).total,
    refetchInterval: 60_000,
    enabled: !onTab,
  });
  return onTab ? 0 : (q.data ?? 0);
}

/** Admin → Errors: grouped client (web/TV) and API errors. */
export function ErrorsTab() {
  const { t } = useI18n();
  // The previous visit, captured once: groups first seen after it are "new".
  const [prevView] = useState(() => readLastViewed());
  const [filters, setFilters] = useState<Filters>({ app: "", kind: "", status: "unresolved", range: "7d", q: "", sort: "last_seen", user: "" });
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const h = setTimeout(() => setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() })), 300);
    return () => clearTimeout(h);
  }, [search]);

  const users = useQuery({
    queryKey: [...LIST_KEY, "users"],
    queryFn: async () => (await unwrap(api.GET("/admin/client-errors/users"))).items,
    staleTime: 60_000,
  });
  const userName = (id: string) => {
    const u = users.data?.find((x) => x.id === id);
    return u ? u.display_name || u.username : "";
  };

  const since = sinceFor(filters.range);
  const list = useInfiniteQuery({
    queryKey: [...LIST_KEY, "list", { ...filters, since }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/admin/client-errors", {
          params: {
            query: {
              status: filters.status,
              sort: filters.sort,
              offset: pageParam,
              limit: PAGE,
              ...(filters.app ? { app: filters.app } : {}),
              ...(filters.kind ? { kind: filters.kind } : {}),
              ...(filters.q ? { q: filters.q } : {}),
              ...(filters.user ? { user_id: filters.user } : {}),
              ...(since ? { since } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total && last.items.length > 0 ? loaded : undefined;
    },
    refetchInterval: 30_000,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-3" data-testid="errors-tab">
      <Card className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-7">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("admin.errors.search")}
          aria-label={t("admin.errors.search")}
          className="col-span-2 sm:col-span-3 lg:col-span-1"
          data-testid="errors-search"
        />
        <Select value={filters.app} onChange={(e) => set("app", e.target.value as Filters["app"])} aria-label={t("admin.errors.filter.app")} data-testid="errors-filter-app">
          <option value="">{t("admin.errors.filter.all_apps")}</option>
          {ERROR_APPS.map((a) => (
            <option key={a} value={a}>
              {t(`admin.errors.app.${a}` as MessageKey)}
            </option>
          ))}
        </Select>
        <Select value={filters.kind} onChange={(e) => set("kind", e.target.value as Filters["kind"])} aria-label={t("admin.errors.filter.kind")}>
          <option value="">{t("admin.errors.filter.all_kinds")}</option>
          {ERROR_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`admin.errors.kind.${k}` as MessageKey)}
            </option>
          ))}
        </Select>
        <Select value={filters.user} onChange={(e) => set("user", e.target.value)} aria-label={t("admin.errors.filter.user")} data-testid="errors-filter-user">
          <option value="">{t("admin.errors.filter.all_users")}</option>
          {filters.user && !users.data?.some((u) => u.id === filters.user) && <option value={filters.user}>{filters.user.slice(0, 8)}</option>}
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name && u.display_name !== u.username ? `${u.display_name} (${u.username})` : u.username}
            </option>
          ))}
        </Select>
        <Select value={filters.status} onChange={(e) => set("status", e.target.value as Status)} aria-label={t("admin.errors.filter.status")} data-testid="errors-filter-status">
          {(["unresolved", "resolved", "all"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`admin.errors.status.${s}` as MessageKey)}
            </option>
          ))}
        </Select>
        <Select value={filters.range} onChange={(e) => set("range", e.target.value as TimeRange)} aria-label={t("admin.errors.filter.range")}>
          {TIME_RANGES.map((r) => (
            <option key={r} value={r}>
              {t(`admin.errors.range.${r}` as MessageKey)}
            </option>
          ))}
        </Select>
        <Select value={filters.sort} onChange={(e) => set("sort", e.target.value as Sort)} aria-label={t("admin.errors.filter.sort")}>
          <option value="last_seen">{t("admin.errors.sort.last_seen")}</option>
          <option value="count">{t("admin.errors.sort.count")}</option>
        </Select>
      </Card>

      <ErrorText error={list.error} />
      {list.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface py-10 text-center text-sm text-muted" data-testid="errors-empty">
          {t("admin.errors.empty")}
        </div>
      ) : (
        <>
          <p className="px-1 text-xs text-muted">
            {t("admin.errors.total", { n: total })}
            {filters.user && userName(filters.user) && ` · ${t("admin.errors.user_scope", { name: userName(filters.user) })}`}
          </p>
          <ul className="space-y-2" data-testid="errors-list">
            {items.map((g) => (
              <GroupRow key={g.id} g={g} isNew={isNewGroup(g, prevView)} onOpen={() => setOpenId(g.id)} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t("admin.errors.load_more")}
              </Button>
            </div>
          )}
        </>
      )}
      {openId && <ErrorDetailSheet id={openId} userId={filters.user} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function AppBadge({ app }: { app: ErrorApp }) {
  const { t } = useI18n();
  return (
    <span className={`shrink-0 rounded px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide ${APP_BADGE[app]}`}>
      {t(`admin.errors.app.${app}` as MessageKey)}
    </span>
  );
}

function Markers({ g, isNew }: { g: ErrorGroup; isNew: boolean }) {
  const { t } = useI18n();
  return (
    <>
      {g.status === "unresolved" && g.regressed && (
        <span className="shrink-0 rounded bg-danger/15 px-1.5 py-px text-[11px] font-semibold text-danger" data-testid="error-regressed">
          {t("admin.errors.regressed")}
        </span>
      )}
      {isNew && !g.regressed && (
        <span className="shrink-0 rounded bg-accent px-1.5 py-px text-[11px] font-semibold text-on-accent" data-testid="error-new">
          {t("admin.errors.new")}
        </span>
      )}
      {g.status === "resolved" && (
        <span className="shrink-0 rounded bg-ok/15 px-1.5 py-px text-[11px] font-semibold text-ok">{t("admin.errors.resolved")}</span>
      )}
    </>
  );
}

function GroupRow({ g, isNew, onOpen }: { g: ErrorGroup; isNew: boolean; onOpen: () => void }) {
  const { t, locale } = useI18n();
  return (
    <li
      data-testid="error-group"
      data-id={g.id}
      data-app={g.app}
      data-count={g.count}
      data-status={g.status}
      data-regressed={String(g.regressed)}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 gap-3 rounded-2xl border border-border bg-surface p-3 text-left transition hover:border-accent/60 focus-visible:border-accent"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <AppBadge app={g.app} />
            <span className="text-xs text-muted">{t(`admin.errors.kind.${g.kind}` as MessageKey)}</span>
            <Markers g={g} isNew={isNew} />
          </div>
          <p className="line-clamp-2 break-words text-sm font-medium" data-testid="error-message">
            {g.message}
          </p>
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>{t("admin.errors.last_seen", { when: timeAgo(g.last_seen, locale) })}</span>
            <span>
              {t("admin.errors.affected", { users: g.users_affected, devices: g.devices_affected })}
            </span>
            {g.last_release && <span className="max-w-full truncate font-mono">{g.last_release}</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center">
          <span className="text-xl font-semibold tabular-nums" data-testid="error-count">
            {g.count}
          </span>
          <span className="text-[11px] text-muted">{t("admin.errors.times")}</span>
        </div>
      </button>
    </li>
  );
}

/** One group; with userId, as that user saw it and only their samples. */
function ErrorDetailSheet({ id, userId, onClose }: { id: string; userId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const q = useQuery({
    queryKey: [...LIST_KEY, "detail", id, userId],
    queryFn: () =>
      unwrap(api.GET("/admin/client-errors/{id}", { params: { path: { id }, query: userId ? { user_id: userId } : {} } })),
  });
  const resolve = useMutation({
    mutationFn: (resolved: boolean) => unwrap(api.PATCH("/admin/client-errors/{id}", { params: { path: { id } }, body: { resolved } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
  const del = useMutation({
    mutationFn: () => unwrap(api.DELETE("/admin/client-errors/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      onClose();
      void qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
  const d = q.data;
  const g = d?.group;
  const fmt = (iso: string) => new Date(iso).toLocaleString(locale);

  return (
    <Sheet title={t("admin.errors.detail")} onClose={onClose} wide testId="error-detail">
      {!d || !g ? (
        q.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <ErrorText error={q.error} />
        )
      ) : (
        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <AppBadge app={g.app} />
              <span className="text-xs text-muted">{t(`admin.errors.kind.${g.kind}` as MessageKey)}</span>
              <Markers g={g} isNew={false} />
            </div>
            <p className="whitespace-pre-wrap break-words font-medium" data-testid="error-detail-message">
              {g.message}
            </p>
            {g.top_frame && <p className="break-all font-mono text-xs text-muted">{g.top_frame}</p>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {g.component && <Row label={t("admin.errors.component")} value={g.component} />}
              <Row label={t("admin.errors.count")} value={String(g.count)} />
              <Row label={t("admin.errors.affected_label")} value={t("admin.errors.affected", { users: g.users_affected, devices: g.devices_affected })} />
              <Row label={t("admin.errors.first_seen")} value={fmt(g.first_seen)} />
              <Row label={t("admin.errors.last_seen_label")} value={fmt(g.last_seen)} />
              {g.last_release && <Row label={t("admin.errors.release")} value={g.last_release} mono />}
            </dl>
          </div>

          <div className="flex flex-wrap gap-2">
            {g.status === "unresolved" ? (
              <Button busy={resolve.isPending} onClick={() => resolve.mutate(true)} data-testid="error-resolve">
                {t("admin.errors.resolve")}
              </Button>
            ) : (
              <Button variant="secondary" busy={resolve.isPending} onClick={() => resolve.mutate(false)} data-testid="error-reopen">
                {t("admin.errors.reopen")}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={async () => {
                if (await copyText(groupAsText(g, d.samples))) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
              data-testid="error-copy"
            >
              {copied ? t("admin.errors.copied") : t("admin.errors.copy")}
            </Button>
            {confirmDelete ? (
              <Button variant="danger" busy={del.isPending} onClick={() => del.mutate()} data-testid="error-delete-confirm">
                {t("admin.errors.delete_confirm")}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)} data-testid="error-delete">
                {t("admin.errors.delete")}
              </Button>
            )}
          </div>
          <ErrorText error={resolve.error ?? del.error} />

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("admin.errors.samples", { n: d.samples.length })}</h3>
            <ul className="space-y-2">
              {d.samples.map((s) => (
                <SampleItem key={s.id} s={s} when={`${fmt(s.occurred_at)} · ${timeAgo(s.occurred_at, locale)}`} />
              ))}
            </ul>
          </section>
        </div>
      )}
    </Sheet>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-xs leading-5" : ""}`}>{value}</dd>
    </>
  );
}

function SampleItem({ s, when }: { s: ErrorSample; when: string }) {
  const { t } = useI18n();
  const who = [s.user && (s.user.display_name || s.user.username), s.device?.name, s.profile_name].filter(Boolean).join(" · ");
  return (
    <li className="min-w-0 space-y-1.5 rounded-xl border border-border bg-surface-2/40 p-3 text-sm" data-testid="error-sample">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <span className="font-medium">{who || t("admin.errors.anonymous")}</span>
        <span className="text-xs text-muted">
          {when}
          {s.count > 1 && ` · ×${s.count}`}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {s.url && <Row label={t("admin.errors.url")} value={s.url} mono />}
        {s.release && <Row label={t("admin.errors.release")} value={s.release} mono />}
        {s.component && <Row label={t("admin.errors.component")} value={s.component} />}
        {s.device_model && <Row label={t("admin.errors.model")} value={s.device_model} />}
        {s.request_id && <Row label={t("admin.errors.request_id")} value={s.request_id} mono />}
      </dl>
      {s.message && s.message !== "" && <p className="whitespace-pre-wrap break-words text-xs">{s.message}</p>}
      {s.user_agent && <p className="break-all text-[11px] text-muted">{s.user_agent}</p>}
      {s.extra && (
        <pre className="max-h-40 overflow-auto rounded-lg bg-bg p-2 font-mono text-[11px] leading-4">{JSON.stringify(s.extra, null, 2)}</pre>
      )}
      {s.stack && (
        <details>
          <summary className="cursor-pointer select-none text-xs font-medium text-accent">{t("admin.errors.stack")}</summary>
          <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-bg p-2 font-mono text-[11px] leading-4" data-testid="error-stack">
            {s.stack}
          </pre>
        </details>
      )}
    </li>
  );
}
