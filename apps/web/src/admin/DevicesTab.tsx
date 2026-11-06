// Admin → «Устройства» (super_admin only): every household TV grouped by
// owner, and the connection (pairing) requests of the last hour. Refreshes on
// realtime `admin.devices.updated` (device online/offline/changed, pairing
// created/approved/rejected/expired) and every 30 s as a fallback. Device
// metadata only; every action is audited server-side.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { Spinner, StatusDot, useI18n, type MessageKey } from "@martytv/ui";
import { api, realtime } from "../api";
import { Button, Card, ErrorText, Field, fieldErrors, Input, Select, timeAgo } from "../components";
import { Sheet } from "../remote/SendToTv";
import { useNow } from "../downloads/ui";
import { DevicePrefsButton } from "../devprefs/ui";
import { HealthLine } from "../health/HealthLine";

type AdminDevice = Schemas["AdminDevice"];
type PairingRequest = Schemas["AdminPairingRequest"];

const DEVICES_KEY = ["admin", "devices"] as const;
const PAIRING_KEY = ["admin", "pairing"] as const;

export function DevicesTab() {
  const qc = useQueryClient();
  useEffect(
    () =>
      realtime.on((env) => {
        if (env.type !== "admin.devices.updated") return;
        void qc.invalidateQueries({ queryKey: DEVICES_KEY });
        void qc.invalidateQueries({ queryKey: PAIRING_KEY });
      }),
    [qc],
  );
  return (
    <div className="space-y-4">
      <PairingCard />
      <DevicesCard />
    </div>
  );
}

function DevicesCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: async () => (await unwrap(api.GET("/admin/devices"))).items,
    refetchInterval: 30_000,
  });
  const done = () => void qc.invalidateQueries({ queryKey: DEVICES_KEY });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => unwrap(api.PATCH("/admin/devices/{id}", { params: { path: { id: v.id } }, body: { name: v.name } })),
    onSettled: done,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/admin/devices/{id}/revoke-credential", { params: { path: { id } } })),
    onSettled: done,
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/admin/devices/{id}", { params: { path: { id } } })),
    onSettled: done,
  });
  const groups = useMemo(() => {
    const m = new Map<string, AdminDevice[]>();
    for (const d of q.data ?? []) m.set(d.owner_user_id, [...(m.get(d.owner_user_id) ?? []), d]);
    return [...m.values()];
  }, [q.data]);
  const busy = rename.isPending || revoke.isPending || remove.isPending;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t("admin.devices.title")}</h2>
        {q.data && <span className="text-xs text-muted">{t("admin.devices.count", { n: q.data.length })}</span>}
      </div>
      <p className="text-xs text-muted">{t("admin.devices.privacy")}</p>
      {q.isPending && <Spinner />}
      <ErrorText error={q.error ?? rename.error ?? revoke.error ?? remove.error} />
      {q.data?.length === 0 && <p className="text-sm text-muted">{t("admin.devices.empty")}</p>}
      {groups.map((list) => {
        const owner = list[0]!;
        return (
          <section key={owner.owner_user_id} className="space-y-2" data-testid="admin-device-owner">
            <h3 className="text-sm font-medium">
              {owner.owner_display_name || owner.owner_username}
              {owner.owner_display_name && <span className="ml-1.5 text-xs font-normal text-muted">@{owner.owner_username}</span>}
            </h3>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {list.map((d) => (
                <li key={d.id} className="space-y-1.5 p-3 text-sm" data-testid="admin-device" data-device-id={d.id}>
                  <div className="flex items-center gap-2">
                    <StatusDot online={d.online} />
                    <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                    <span className={`shrink-0 text-xs ${d.online ? "text-ok" : "text-muted"}`}>
                      {d.online ? t("admin.devices.online") : t("admin.devices.offline")}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    {[
                      d.platform,
                      d.app_version ? t("admin.devices.version", { version: d.app_version }) : null,
                      d.online ? null : d.last_seen_at ? t("admin.devices.last_seen", { when: timeAgo(d.last_seen_at, locale) }) : t("admin.devices.never_seen"),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {d.model && (
                    <p className="truncate text-xs text-muted" title={d.model}>
                      {d.model}
                    </p>
                  )}
                  <HealthLine deviceId={d.id} />
                  {d.default_profile_name && <p className="text-xs text-muted">{t("admin.devices.default_profile", { name: d.default_profile_name })}</p>}
                  {d.shares.length > 0 && (
                    <p className="text-xs text-muted">
                      {t("admin.devices.shared_with", {
                        list: d.shares.map((s) => `${s.display_name || s.username} (${t(`admin.devices.share.${s.permission}` as MessageKey)})`).join(", "),
                      })}
                    </p>
                  )}
                  {!d.credential_active && <p className="text-xs text-danger">{t("admin.devices.no_credential")}</p>}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      variant="secondary"
                      className="min-h-0 py-1 text-sm"
                      disabled={busy}
                      onClick={() => {
                        const name = prompt(t("admin.devices.rename_prompt", { name: d.name }), d.name)?.trim();
                        if (name && name !== d.name) rename.mutate({ id: d.id, name });
                      }}
                    >
                      {t("admin.devices.rename")}
                    </Button>
                    <DevicePrefsButton deviceId={d.id} name={d.name} className="min-h-0 py-1 text-sm" />
                    {d.credential_active && (
                      <Button
                        variant="secondary"
                        className="min-h-0 py-1 text-sm"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(t("admin.devices.revoke_confirm", { name: d.name, owner: d.owner_username }))) revoke.mutate(d.id);
                        }}
                      >
                        {t("admin.devices.revoke")}
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      className="min-h-0 py-1 text-sm"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(t("admin.devices.delete_confirm", { name: d.name, owner: d.owner_username }))) remove.mutate(d.id);
                      }}
                    >
                      {t("admin.devices.delete")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}

const STATUS_TONE: Record<PairingRequest["status"], string> = {
  pending: "border-accent/40 bg-accent/10 text-accent",
  approved: "border-ok/40 bg-ok/10 text-ok",
  expired: "border-border bg-surface-2 text-muted",
  denied: "border-danger/40 bg-danger/10 text-danger",
};

function PairingCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const now = useNow(1000);
  const q = useQuery({
    queryKey: PAIRING_KEY,
    queryFn: async () => (await unwrap(api.GET("/admin/pairing"))).items,
    refetchInterval: 30_000,
  });
  const reject = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/admin/pairing/{id}/reject", { params: { path: { id } } })),
    onSettled: () => void qc.invalidateQueries({ queryKey: PAIRING_KEY }),
  });
  const [approving, setApproving] = useState<PairingRequest | null>(null);

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">{t("admin.pairing.title")}</h2>
      {q.isPending && <Spinner />}
      <ErrorText error={q.error ?? reject.error} />
      {q.data?.length === 0 && <p className="text-sm text-muted">{t("admin.pairing.empty")}</p>}
      {q.data && q.data.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {q.data.map((r) => {
            const left = Date.parse(r.expires_at) - now;
            // The countdown flips a live request to «expired» before the server's event arrives.
            const status = (r.status === "pending" || r.status === "approved") && left <= 0 ? "expired" : r.status;
            const live = status === "pending" || status === "approved";
            return (
              <li key={r.id} className="space-y-1.5 p-3 text-sm" data-testid="admin-pairing" data-pairing-id={r.id} data-status={status}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold tracking-wider">{r.user_code}</span>
                  <span className="min-w-0 flex-1 truncate">{r.device_name}</span>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${STATUS_TONE[status]}`} data-testid="pairing-status">
                    {status === "approved" && r.approved_by_username
                      ? t("admin.pairing.approved_to", { name: r.approved_by_username })
                      : t(`admin.pairing.status.${status}` as MessageKey)}
                  </span>
                </div>
                <p className="text-xs text-muted">
                  {[
                    r.platform || null,
                    r.ip ? `IP ${r.ip}` : null,
                    t("admin.pairing.opened", { when: timeAgo(r.created_at, locale) }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {live && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs tabular-nums text-muted" data-testid="pairing-countdown">
                      {t("admin.pairing.expires_in", { time: countdown(left) })}
                    </span>
                    <div className="flex flex-wrap gap-2">
                    {status === "pending" && (
                      <Button className="min-h-0 py-1 text-sm" onClick={() => setApproving(r)} data-testid="pairing-approve">
                        {t("admin.pairing.approve")}
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      className="min-h-0 py-1 text-sm"
                      disabled={reject.isPending}
                      onClick={() => {
                        if (confirm(t("admin.pairing.reject_confirm", { name: r.device_name, code: r.user_code }))) reject.mutate(r.id);
                      }}
                    >
                      {status === "approved" ? t("admin.pairing.cancel") : t("admin.pairing.reject")}
                    </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {approving && <ApproveSheet request={approving} onClose={() => setApproving(null)} />}
    </Card>
  );
}

/** «Принять и назначить…»: accept a waiting TV for someone (POST /admin/pairing/{id}/approve). */
function ApproveSheet({ request, onClose }: { request: PairingRequest; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [userId, setUserId] = useState("");
  const [name, setName] = useState(request.device_name);
  const [profileId, setProfileId] = useState("");
  const people = useQuery({
    queryKey: ["admin", "pairing", "assignees"],
    queryFn: async () => (await unwrap(api.GET("/admin/pairing/assignees"))).items,
  });
  const person = people.data?.find((u) => u.id === userId);
  const approve = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/admin/pairing/{id}/approve", {
          params: { path: { id: request.id } },
          body: { user_id: userId, device_name: name.trim() || undefined, default_profile_id: profileId || undefined },
        }),
      ),
    onSuccess: onClose,
    onSettled: () => void qc.invalidateQueries({ queryKey: PAIRING_KEY }),
  });
  const errs = fieldErrors(approve.error);
  return (
    <Sheet title={t("admin.pairing.approve_title", { name: request.device_name })} subtitle={request.user_code} onClose={onClose} testId="approve-sheet">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (userId) approve.mutate();
        }}
      >
        <Field label={t("admin.pairing.approve_user")} error={errs.user_id}>
          <Select
            value={userId}
            data-testid="approve-user"
            onChange={(e) => {
              setUserId(e.target.value);
              setProfileId("");
            }}
            required
          >
            <option value="" disabled>
              {t("admin.pairing.approve_pick")}
            </option>
            {people.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name ? `${u.display_name} (@${u.username})` : u.username}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("admin.pairing.approve_name")} error={errs.device_name}>
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} data-testid="approve-name" />
        </Field>
        <Field label={t("admin.pairing.approve_profile")} error={errs.default_profile_id}>
          <Select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={!person} data-testid="approve-profile">
            <option value="">{t("admin.pairing.approve_profile_auto")}</option>
            {person?.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorText error={people.error ?? (Object.keys(errs).length ? null : approve.error)} />
        <Button type="submit" className="w-full" busy={approve.isPending} disabled={!userId} data-testid="approve-confirm">
          {t("admin.pairing.approve_confirm")}
        </Button>
      </form>
    </Sheet>
  );
}

/** m:ss for the time left (never negative). */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
