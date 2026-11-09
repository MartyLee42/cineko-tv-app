import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAdminRole, isSuperAdminRole, unwrap, type ActivityItem, type Role, type Schemas } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { ProfileAvatar, Spinner, StatusDot, useI18n, type MessageKey } from "@martytv/ui";
import { api, realtime } from "../api";
import { useSession } from "../session";
import { Button, Card, ErrorText, Field, fieldErrors, Input, PageTitle, Select, timeAgo } from "../components";
import { Img } from "../catalog/components";
import { useCatalogConfig, useCatalogLang } from "../catalog/queries";
import { Sheet } from "../remote/SendToTv";
import { HistoryRow } from "./HistoryPage";
import { ProgressBar } from "../watch/components";
import { formatClock } from "../watch/format";
import { activityPercent } from "../watch/admin";
import { ServerTab } from "../admin/ServerTab";
import { ErrorsTab, useUnseenErrors } from "../admin/ErrorsTab";
import { SourcesTab } from "../admin/SourcesTab";
import { ForYouTab } from "../admin/ForYouTab";
import { StorageTab } from "../admin/StorageTab";
import { IptvTab } from "../admin/IptvTab";
import { DevicesTab } from "../admin/DevicesTab";
import { IncidentsTab, useIncidents } from "../admin/IncidentsTab";
import { SeasonalAdminCard } from "../seasons/SeasonalSetting";
import { NewEpisodesAdminCard } from "../newepisodes/AdminCard";
import { FamilyVisibilityCard } from "../family/VisibilityCard";

export function AdminPage() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const superAdmin = isSuperAdminRole(session?.user.role);
  const tab: AdminTab =
    tabParam === "server" || tabParam === "incidents" || tabParam === "errors" || tabParam === "sources" || tabParam === "foryou" || tabParam === "storage" || tabParam === "iptv" || (tabParam === "devices" && superAdmin)
      ? tabParam
      : "overview";
  if (!session || !isAdminRole(session.user.role)) return <Navigate to="/" replace />;
  return (
    <div className="space-y-4">
      <PageTitle>{t("nav.admin")}</PageTitle>
      <AdminTabs tab={tab} superAdmin={superAdmin} onChange={(next) => setParams(next === "overview" ? {} : { tab: next }, { replace: true })} />
      {tab === "server" ? (
        <div role="tabpanel" id="admin-panel-server" aria-labelledby="admin-tab-server">
          <ServerTab />
        </div>
      ) : tab === "incidents" ? (
        <div role="tabpanel" id="admin-panel-incidents" aria-labelledby="admin-tab-incidents">
          <IncidentsTab />
        </div>
      ) : tab === "errors" ? (
        <div role="tabpanel" id="admin-panel-errors" aria-labelledby="admin-tab-errors">
          <ErrorsTab />
        </div>
      ) : tab === "sources" ? (
        <div role="tabpanel" id="admin-panel-sources" aria-labelledby="admin-tab-sources">
          <SourcesTab />
        </div>
      ) : tab === "storage" ? (
        <div role="tabpanel" id="admin-panel-storage" aria-labelledby="admin-tab-storage">
          <StorageTab />
        </div>
      ) : tab === "iptv" ? (
        <div role="tabpanel" id="admin-panel-iptv" aria-labelledby="admin-tab-iptv">
          <IptvTab />
        </div>
      ) : tab === "devices" ? (
        <div role="tabpanel" id="admin-panel-devices" aria-labelledby="admin-tab-devices">
          <DevicesTab />
        </div>
      ) : tab === "foryou" ? (
        <div role="tabpanel" id="admin-panel-foryou" aria-labelledby="admin-tab-foryou">
          <ForYouTab />
        </div>
      ) : (
        <div role="tabpanel" id="admin-panel-overview" aria-labelledby="admin-tab-overview" className="space-y-4">
          <ActivityCard />
          <IntegrationsCard />
          <NewEpisodesAdminCard />
          <UsersCard selfId={session.user.id} selfRole={session.user.role} />
          <FamilyVisibilityCard />
          <MessagesCard selfId={session.user.id} />
          <SeasonalAdminCard />
        </div>
      )}
    </div>
  );
}

type AdminTab = "overview" | "server" | "incidents" | "errors" | "sources" | "foryou" | "storage" | "iptv" | "devices";

function AdminTabs({ tab, superAdmin, onChange }: { tab: AdminTab; superAdmin: boolean; onChange: (t: AdminTab) => void }) {
  const { t, locale } = useI18n();
  const tabs: { id: AdminTab; label: MessageKey }[] = [
    { id: "overview", label: "admin.tab.overview" },
    { id: "server", label: "admin.tab.server" },
    { id: "incidents", label: "alerts.tab" },
    { id: "errors", label: "admin.tab.errors" },
    { id: "sources", label: "admin.tab.sources" },
    { id: "foryou", label: "fy.admin.tab" },
    { id: "storage", label: "downloads.admin.tab" },
    { id: "iptv", label: "iptv.admin.tab" },
    // super_admin only: every household TV and connection request.
    ...(superAdmin ? [{ id: "devices" as const, label: "admin.tab.devices" as const }] : []),
  ];
  const unseenErrors = useUnseenErrors(tab === "errors");
  const openIncidents = useIncidents(locale).data?.open ?? 0;
  return (
    <div role="tablist" aria-label={t("nav.admin")} className="no-scrollbar inline-flex max-w-full overflow-x-auto rounded-full border border-border bg-surface p-1">
      {tabs.map((x) => (
        <button
          key={x.id}
          id={`admin-tab-${x.id}`}
          type="button"
          role="tab"
          aria-selected={tab === x.id}
          aria-controls={`admin-panel-${x.id}`}
          onClick={() => onChange(x.id)}
          className={`min-h-[36px] shrink-0 whitespace-nowrap rounded-full px-4 text-sm font-medium transition ${
            tab === x.id ? "bg-accent text-on-accent" : "text-muted hover:text-text"
          }`}
        >
          {t(x.label)}
          {x.id === "incidents" && openIncidents > 0 && (
            <span
              className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-semibold leading-5 text-bg"
              aria-label={t("alerts.tab_badge", { n: openIncidents })}
              data-testid="incidents-tab-badge"
            >
              {openIncidents}
            </span>
          )}
          {x.id === "errors" && unseenErrors > 0 && (
            <span
              className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-semibold leading-5 text-bg"
              aria-label={t("admin.errors.tab_badge", { n: unseenErrors })}
              data-testid="errors-tab-badge"
            >
              {unseenErrors > 99 ? "99+" : unseenErrors}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function IntegrationsCard() {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ["admin", "integrations"],
    queryFn: async () => (await unwrap(api.GET("/admin/integrations"))).items,
  });
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold">{t("admin.integrations")}</h2>
      <ErrorText error={q.error} />
      {q.data?.map((s) => (
        <div key={s.name} className="flex items-center gap-2 text-sm">
          <StatusDot online={s.ok} />
          <span className="w-24 font-medium capitalize">{s.name}</span>
          <span className="text-muted">
            {!s.configured ? t("admin.not_configured") : s.ok ? s.version : s.error}
          </span>
        </div>
      ))}
    </Card>
  );
}

const ROLE_LABEL: Record<Role, MessageKey> = { user: "admin.role_user", admin: "admin.role_admin", super_admin: "admin.role_super_admin" };
const ROLE_CONFIRM: Record<Role, MessageKey> = { user: "admin.role_confirm_user", admin: "admin.role_confirm_admin", super_admin: "admin.role_confirm_super_admin" };

function UsersCard({ selfId, selfRole }: { selfId: string; selfRole: Role }) {
  const { t } = useI18n();
  // Only a super_admin manages administrators or grants admin/super_admin;
  // a plain admin manages regular users (the API enforces the same rules).
  const superAdmin = isSuperAdminRole(selfRole);
  const canManage = (target: Role) => superAdmin || target === "user";
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [historyOf, setHistoryOf] = useState<AdminUser | null>(null);
  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => (await unwrap(api.GET("/admin/users"))).items,
  });
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/admin/users", { body: { username, password, role } })),
    onSuccess: () => {
      setUsername("");
      setPassword("");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: string; disabled?: boolean; role?: Role }) =>
      unwrap(api.PATCH("/admin/users/{id}", { params: { path: { id: v.id } }, body: { disabled: v.disabled, role: v.role } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
  const reset = useMutation({
    mutationFn: (v: { id: string; password: string }) =>
      unwrap(api.POST("/admin/users/{id}/password", { params: { path: { id: v.id } }, body: { password: v.password } })),
  });
  const errs = fieldErrors(create.error);

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">{t("admin.users")}</h2>
      <ul className="divide-y divide-border">
        {users.data?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <span className="font-medium">{u.username}</span>
            {u.id === selfId ? (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted" data-testid="self-role">{t(ROLE_LABEL[u.role])}</span>
            ) : (
              <Select
                aria-label={t("admin.role")}
                data-testid="user-role"
                className="w-auto min-h-0 py-1 text-xs"
                value={u.role}
                disabled={update.isPending || !superAdmin}
                title={superAdmin ? undefined : t("admin.role_locked")}
                onChange={(e) => {
                  const next = e.target.value as Role;
                  if (next !== u.role && confirm(t(ROLE_CONFIRM[next], { name: u.username }))) update.mutate({ id: u.id, role: next });
                  else e.target.value = u.role;
                }}
              >
                <option value="user">{t("admin.role_user")}</option>
                <option value="admin">{t("admin.role_admin")}</option>
                {(superAdmin || u.role === "super_admin") && <option value="super_admin">{t("admin.role_super_admin")}</option>}
              </Select>
            )}
            {u.disabled_at && <span className="text-xs text-danger">{t("admin.disabled")}</span>}
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              <Button variant="secondary" className="min-h-0 py-1 text-sm" data-testid="user-history" onClick={() => setHistoryOf(u)}>
                {t("admin.history")}
              </Button>
            {u.id !== selfId && canManage(u.role) && (
              <>
                <Button
                  variant="secondary"
                  className="min-h-0 py-1 text-sm"
                  onClick={() => {
                    const pw = prompt(t("admin.reset_password"));
                    if (pw) reset.mutate({ id: u.id, password: pw });
                  }}
                >
                  {t("admin.reset_password")}
                </Button>
                <Button
                  variant={u.disabled_at ? "secondary" : "danger"}
                  className="min-h-0 py-1 text-sm"
                  onClick={() => update.mutate({ id: u.id, disabled: !u.disabled_at })}
                >
                  {u.disabled_at ? t("admin.enable") : t("admin.disable")}
                </Button>
              </>
            )}
            </div>
          </li>
        ))}
      </ul>
      <ErrorText error={update.error ?? reset.error} />
      <form
        className="grid gap-3 border-t border-border pt-3 sm:grid-cols-4 sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label={t("login.username")} error={errs.username}>
          <Input value={username} autoCapitalize="none" onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label={t("login.password")} error={errs.password}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Field label={t("admin.role")}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={!superAdmin} title={superAdmin ? undefined : t("admin.role_locked")}>
            <option value="user">{t("admin.role_user")}</option>
            {superAdmin && <option value="admin">{t("admin.role_admin")}</option>}
            {superAdmin && <option value="super_admin">{t("admin.role_super_admin")}</option>}
          </Select>
        </Field>
        <Button type="submit" busy={create.isPending}>
          {t("admin.create_user")}
        </Button>
      </form>
      <ErrorText error={Object.keys(errs).length ? null : create.error} />
      {historyOf && <UserHistorySheet user={historyOf} onClose={() => setHistoryOf(null)} />}
    </Card>
  );
}

type AdminUser = Schemas["AdminUser"];

// ---------------------------------------------------------------- watching now

export const useAdminUsers = () =>
  useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => (await unwrap(api.GET("/admin/users"))).items,
  });

function ActivityCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const lang = useCatalogLang();
  const q = useQuery({
    queryKey: ["admin", "activity", lang],
    queryFn: async () => (await unwrap(api.GET("/admin/activity/now", { params: { query: { lang } } }))).items,
    refetchInterval: 5000,
  });
  // TV state changes (play/pause/stop) refresh the list right away (throttled).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = realtime.on((env) => {
      if (env.type !== "device.state" || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void qc.invalidateQueries({ queryKey: ["admin", "activity"] });
      }, 800);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [qc]);

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
        </span>
        <h2 className="font-semibold">{t("admin.activity")}</h2>
      </div>
      <ErrorText error={q.error} />
      {q.isPending ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : !q.data?.length ? (
        <p className="py-2 text-sm text-muted" data-testid="activity-empty">
          {t("admin.activity_empty")}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="activity-list">
          {q.data.map((a, i) => (
            <ActivityCardItem key={`${a.device?.id ?? a.user.id}-${i}`} a={a} />
          ))}
        </ul>
      )}
    </Card>
  );
}

const STATE_KEY: Record<ActivityItem["state"], MessageKey> = {
  playing: "admin.state.playing",
  paused: "admin.state.paused",
  buffering: "admin.state.buffering",
  preparing: "admin.state.preparing",
  unknown: "admin.state.unknown",
};

function ActivityCardItem({ a }: { a: ActivityItem }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const pct = activityPercent(a);
  return (
    <li className="flex min-w-0 gap-3 rounded-xl border border-border bg-bg/40 p-2.5" data-testid="activity-item">
      <div className="relative aspect-[2/3] w-14 shrink-0 overflow-hidden rounded-lg" style={{ background: placeholderColor(a.media.title) }}>
        <Img src={imageUrl(cfg, a.media.poster_path, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate font-semibold leading-tight">
          {a.media.title}
          {a.episode_label && <span className="font-normal text-muted"> · {a.episode_label}</span>}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{a.user.display_name || a.user.username}</span>
          {a.profile && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-0.5 pr-2">
              <ProfileAvatar name={a.profile.name} color={a.profile.color} size={16} className="!rounded-full" />
              {a.profile.name}
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted">
          {[a.device?.name, a.player && t(`player.kind.${a.player}` as MessageKey)].filter(Boolean).join(" · ")}
        </p>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`shrink-0 rounded px-1.5 py-px font-semibold ${
              a.state === "playing" ? "bg-ok/15 text-ok" : "bg-surface-2 text-muted"
            }`}
          >
            {a.state === "playing" ? "▶" : a.state === "paused" ? "❚❚" : "…"} {t(STATE_KEY[a.state])}
          </span>
          {pct != null && <ProgressBar value={pct} className="flex-1" />}
          {a.position_seconds != null && (
            <span className="shrink-0 tabular-nums text-muted">
              {formatClock(a.position_seconds)}
              {a.duration_seconds ? ` / ${formatClock(a.duration_seconds)}` : ""}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- per-user history

function UserHistorySheet({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useI18n();
  const lang = useCatalogLang();
  const q = useInfiniteQuery({
    queryKey: ["admin", "history", user.id, lang],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/admin/users/{id}/history", {
          params: { path: { id: user.id }, query: { lang, limit: 30, ...(pageParam && { cursor: pageParam }) } },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Sheet wide title={`${t("admin.history")} · ${user.display_name || user.username}`} onClose={onClose} testId="admin-history">
      {q.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : !items.length ? (
        <p className="py-8 text-center text-muted">{t("watch.history_empty")}</p>
      ) : (
        <div className="max-h-[65vh] space-y-3 overflow-y-auto">
          <ol className="space-y-2">
            {items.map((h, i) => (
              <HistoryRow
                key={`${h.media.id}-${h.progress.episode_id ?? ""}-${i}`}
                h={h}
                extra={
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
                    <ProfileAvatar name={h.profile.name} color={h.profile.color} size={14} className="!rounded-full" />
                    {[h.profile.name, h.device_name].filter(Boolean).join(" · ")}
                  </p>
                }
              />
            ))}
          </ol>
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {t("catalog.load_more")}
              </Button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- messages

function MessagesCard({ selfId }: { selfId: string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const users = useAdminUsers();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [everyone, setEveryone] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [onTv, setOnTv] = useState(true);
  const sent = useQuery({
    queryKey: ["admin", "messages"],
    queryFn: async () => (await unwrap(api.GET("/admin/messages"))).items,
    refetchInterval: 30_000,
  });
  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/admin/messages", {
          body: { title, body, show_on_tv: onTv, ...(!everyone && { user_ids: picked }) },
        }),
      ),
    onSuccess: () => {
      setTitle("");
      setBody("");
      void qc.invalidateQueries({ queryKey: ["admin", "messages"] });
    },
  });
  const errs = fieldErrors(send.error);
  const others = (users.data ?? []).filter((u) => u.id !== selfId && !u.disabled_at);

  return (
    <Card className="space-y-4">
      <h2 className="font-semibold">{t("admin.send_message")}</h2>
      <form
        className="space-y-3"
        data-testid="send-message-form"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <Field label={t("admin.message_title")} error={errs.title}>
          <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
        </Field>
        <Field label={t("admin.message_body")} error={errs.body}>
          <textarea
            value={body}
            maxLength={1000}
            rows={3}
            onChange={(e) => setBody(e.target.value)}
            required
            className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
          />
        </Field>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            {t("admin.message_everyone")}
          </label>
          {!everyone && (
            <div className="flex flex-wrap gap-1.5 pl-6">
              {others.map((u) => {
                const on = picked.includes(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPicked((cur) => (on ? cur.filter((x) => x !== u.id) : [...cur, u.id]))}
                    className={`min-h-[36px] rounded-full border px-3 text-sm transition ${
                      on ? "border-accent bg-accent/15 text-accent-strong" : "border-border hover:border-muted"
                    }`}
                  >
                    {u.display_name || u.username}
                  </button>
                );
              })}
            </div>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={onTv} onChange={(e) => setOnTv(e.target.checked)} />
            {t("admin.message_show_on_tv")}
          </label>
        </div>
        <ErrorText error={Object.keys(errs).length ? null : send.error} />
        {send.isSuccess && <p className="text-sm text-ok">{t("admin.message_sent", { n: send.data.recipients })}</p>}
        <Button type="submit" busy={send.isPending} disabled={!everyone && !picked.length}>
          {t("admin.send_message")}
        </Button>
      </form>
      {!!sent.data?.length && (
        <ul className="divide-y divide-border border-t border-border" data-testid="sent-messages">
          {sent.data.map((m) => (
            <li key={m.id} className="py-2.5 text-sm">
              <div className="flex items-baseline gap-2">
                <p className="min-w-0 flex-1 truncate font-medium">{m.title}</p>
                <span className="shrink-0 text-xs text-muted">{timeAgo(m.created_at, locale)}</span>
              </div>
              <p className="line-clamp-2 text-muted">{m.body}</p>
              <p className="mt-0.5 text-xs text-muted">
                {t("admin.message_read", { n: m.read_count, total: m.recipients })}
                {m.show_on_tv && " · TV"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
