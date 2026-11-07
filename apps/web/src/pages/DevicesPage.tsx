import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CommandError, unwrap, type Device } from "@martytv/contracts";
import { StatusDot, useI18n } from "@martytv/ui";
import { api, realtime } from "../api";
import { useDevices, useProfiles } from "../queries";
import { Button, Card, ErrorText, Field, Input, PageTitle, Select, timeAgo } from "../components";
import { RemoteIcon } from "../icons";
import { useDeviceState } from "../remote/state";
import { useStateLine } from "../remote/SendToTv";
import { DevicePrefsButton, PlaybackClientsCard } from "../devprefs/ui";
import { HealthLine } from "../health/HealthLine";

export function DevicesPage() {
  const { t } = useI18n();
  const { data: devices, isPending, error } = useDevices();

  return (
    <div>
      <PageTitle
        action={
          <Link to="/pair" className="rounded-xl bg-accent px-4 py-2 font-semibold text-on-accent">
            {t("home.pair_cta")}
          </Link>
        }
      >
        {t("devices.title")}
      </PageTitle>
      <ErrorText error={error} />
      {!isPending && !devices?.length && <p className="text-muted">{t("devices.empty")}</p>}
      <div className="space-y-4">
        {devices?.map((d) => <DeviceCard key={d.id} device={d} />)}
        <PlaybackClientsCard />
      </div>
    </div>
  );
}

function DeviceCard({ device: d }: { device: Device }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { data: profiles } = useProfiles();
  const [name, setName] = useState(d.name);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isOwner = d.access === "owner";
  const live = useDeviceState(d.id);
  const stateLine = useStateLine();
  const online = live.data?.online ?? d.online;

  const update = useMutation({
    mutationFn: (body: { name?: string; default_profile_id?: string; clear_default_profile?: boolean }) =>
      unwrap(api.PATCH("/devices/{id}", { params: { path: { id: d.id } }, body })),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
  });

  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE("/devices/{id}", { params: { path: { id: d.id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });

  const ping = useMutation({
    mutationFn: () => realtime.command(d.id, "device.show_message", { text: "👋 Hello from Cineko" }),
    onSuccess: () => setNotice(t("devices.message_sent")),
    onError: (e) => setNotice(t("devices.ping_failed", { code: e instanceof CommandError ? e.code : "error" })),
  });

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                update.mutate({ name });
              }}
            >
              <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} autoFocus />
              <Button type="submit" busy={update.isPending}>
                {t("common.save")}
              </Button>
            </form>
          ) : (
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <StatusDot online={online} />
              <span className="truncate">{d.name}</span>
            </h2>
          )}
          <p className="mt-1 text-sm text-muted">
            {online ? t("common.online") : t("devices.last_seen", { when: timeAgo(d.last_seen_at, locale) })}
            {d.platform ? ` · ${d.platform}` : ""}
            {!isOwner ? ` · ${t("devices.shared_by", { name: d.owner_username })}` : ""}
          </p>
          {isOwner && <HealthLine deviceId={d.id} className="mt-1" />}
          {online && live.data?.state && (
            <p className="mt-0.5 truncate text-sm text-text/80" data-testid="device-state-line">
              {stateLine(d, live.data)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/remote/${d.id}`}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-accent/15 px-4 py-2 font-semibold text-accent transition hover:bg-accent/25"
          >
            <RemoteIcon className="text-lg" />
            {t("remote.remote")}
          </Link>
          <Button variant="secondary" disabled={!online} busy={ping.isPending} onClick={() => ping.mutate()}>
            {t("devices.send_message")}
          </Button>
          {(isOwner || d.access === "use") && (
            // Look, screensaver, language… of this TV (devsettings/TvSettingsPage).
            <Link
              to={`/devices/${d.id}/settings`}
              data-testid="tv-settings-open"
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-surface-2 px-4 py-2 font-semibold transition hover:bg-border"
            >
              {t("devset.tv.button")}
            </Link>
          )}
          {(isOwner || d.access === "use") && <DevicePrefsButton deviceId={d.id} name={d.name} />}
          {isOwner && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t("devices.rename")}
            </Button>
          )}
          {isOwner && (
            <Button
              variant="danger"
              busy={revoke.isPending}
              onClick={() => {
                if (confirm(t("devices.revoke_confirm", { name: d.name }))) revoke.mutate();
              }}
            >
              {t("devices.revoke")}
            </Button>
          )}
        </div>
      </div>
      {notice && <p className="text-sm text-muted">{notice}</p>}
      <ErrorText error={update.error ?? revoke.error} />

      {isOwner && (
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <Field label={t("devices.default_profile")}>
            <Select
              value={d.default_profile_id ?? ""}
              onChange={(e) =>
                update.mutate(e.target.value ? { default_profile_id: e.target.value } : { clear_default_profile: true })
              }
            >
              <option value="">{t("pair.no_default")}</option>
              {profiles?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <SharePanel deviceId={d.id} />
        </div>
      )}
    </Card>
  );
}

function SharePanel({ deviceId }: { deviceId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [permission, setPermission] = useState<"control" | "use">("control");
  const key = ["devices", deviceId, "permissions"];

  const perms = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await unwrap(api.GET("/devices/{id}/permissions", { params: { path: { id: deviceId } } }))).items,
  });
  // Household accounts to pick from (excluding the caller and current shares).
  const directory = useQuery({
    queryKey: ["users", "directory"],
    queryFn: async () => (await unwrap(api.GET("/users/directory"))).items,
    staleTime: 60_000,
  });
  const shared = new Set((perms.data ?? []).map((p) => p.user_id));
  const candidates = (directory.data ?? []).filter((u) => !shared.has(u.id));
  const share = useMutation({
    mutationFn: () =>
      unwrap(api.PUT("/devices/{id}/permissions", { params: { path: { id: deviceId } }, body: { username, permission } })),
    onSuccess: () => {
      setUsername("");
      qc.invalidateQueries({ queryKey: key });
    },
  });
  const unshare = useMutation({
    mutationFn: (userId: string) =>
      unwrap(api.DELETE("/devices/{id}/permissions/{userId}", { params: { path: { id: deviceId, userId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <div className="space-y-2">
      <span className="text-sm text-muted">{t("devices.share")}</span>
      {perms.data?.map((p) => (
        <div key={p.user_id} className="flex items-center gap-2 text-sm">
          <span className="font-medium">{p.username}</span>
          <span className="text-muted">{t(p.permission === "use" ? "devices.permission.use" : "devices.permission.control")}</span>
          <button className="ml-auto text-danger" onClick={() => unshare.mutate(p.user_id)} aria-label="remove">
            ✕
          </button>
        </div>
      ))}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (username.trim()) share.mutate();
        }}
      >
        <Select
          className="min-w-[8rem] flex-1"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-label={t("devices.share_with")}
          disabled={!candidates.length}
        >
          <option value="">{candidates.length ? t("devices.choose_user") : t("devices.no_other_users")}</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.username}>
              {u.display_name ? `${u.display_name} (${u.username})` : u.username}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={permission} onChange={(e) => setPermission(e.target.value as "control" | "use")}>
          <option value="control">{t("devices.permission.control")}</option>
          <option value="use">{t("devices.permission.use")}</option>
        </Select>
        <Button type="submit" variant="secondary" busy={share.isPending} disabled={!username}>
          {t("devices.share")}
        </Button>
      </form>
      {share.error && <p className="text-sm text-danger">{Object.values((share.error as { fields?: Record<string, string> }).fields ?? {})[0] ?? share.error.message}</p>}
    </div>
  );
}
