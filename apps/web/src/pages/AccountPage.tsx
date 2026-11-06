// Account & security cards, shown on the Settings page.
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { api, setCsrfToken } from "../api";
import { Button, Card, ErrorText, Field, fieldErrors, Input, Select, timeAgo } from "../components";
import { clearCatalogCaches } from "../catalog/cache";
import { detectPlatform, LOCAL_DEFAULTS, localOptions, readLocalDefault, writeLocalDefault, type LocalDefault } from "../play/players";

type Scope = Schemas["Scope"];
const SCOPES: Scope[] = ["read", "write", "device:register", "admin"];

const LOCAL_LABEL = {
  ask: "player.local.ask",
  vlc: "player.local.vlc",
  intent: "player.local.intent",
  m3u: "player.local.m3u",
} as const;

/** Per-browser default for "On this device" (stored locally, not on the account). */
export function LocalPlayerField() {
  const { t } = useI18n();
  const [value, setValue] = useState<LocalDefault>(readLocalDefault);
  const [platform] = useState(() => detectPlatform(navigator.userAgent, navigator.maxTouchPoints));
  const available = LOCAL_DEFAULTS.filter((o) => o === "ask" || o === value || localOptions(platform).includes(o));
  return (
    <div>
      <Field label={t("player.local.default_label")}>
        <Select
          value={value}
          data-testid="local-player-default"
          onChange={(e) => {
            const v = e.target.value as LocalDefault;
            setValue(v);
            writeLocalDefault(v);
          }}
          className="sm:w-72"
        >
          {available.map((o) => (
            <option key={o} value={o}>
              {t(LOCAL_LABEL[o])}
            </option>
          ))}
        </Select>
      </Field>
      <p className="mt-2 text-sm text-muted">{t("player.local.default_hint")}</p>
    </div>
  );
}

export function SessionsCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [withDevices, setWithDevices] = useState(false);
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => (await unwrap(api.GET("/auth/sessions"))).items,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/auth/sessions/{id}", { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
  const logoutAll = useMutation({
    mutationFn: () => unwrap(api.POST("/auth/logout-all", { body: { include_devices: withDevices } })),
    onSuccess: () => {
      setCsrfToken(undefined);
      qc.clear();
      void clearCatalogCaches();
      navigate("/login", { replace: true });
    },
  });

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">{t("account.sessions")}</h2>
      <ul className="divide-y divide-border">
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate">{s.current ? t("account.this_device") : s.user_agent || "—"}</p>
              <p className="text-muted">
                {s.ip} · {timeAgo(s.last_seen_at, locale)}
              </p>
            </div>
            {!s.current && (
              <Button variant="secondary" className="min-h-0 py-1 text-sm" onClick={() => revoke.mutate(s.id)}>
                {t("account.revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={withDevices} onChange={(e) => setWithDevices(e.target.checked)} />
        {t("account.logout_all_devices")}
      </label>
      <Button variant="danger" busy={logoutAll.isPending} onClick={() => logoutAll.mutate()}>
        {t("account.logout_all")}
      </Button>
      <ErrorText error={revoke.error ?? logoutAll.error} />
    </Card>
  );
}

export function PasswordCard() {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => unwrap(api.POST("/auth/password", { body: { current_password: current, new_password: next } })),
    onSuccess: () => {
      setCurrent("");
      setNext("");
    },
  });
  const errs = fieldErrors(change.error);
  return (
    <Card>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <h2 className="font-semibold">{t("account.password")}</h2>
        <Field label={t("account.current_password")} error={errs.current_password}>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label={t("account.new_password")} error={errs.new_password}>
          <Input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        {change.isSuccess && <p className="text-sm text-ok">{t("account.password_changed")}</p>}
        <ErrorText error={Object.keys(errs).length ? null : change.error} />
        <Button type="submit" busy={change.isPending}>
          {t("common.save")}
        </Button>
      </form>
    </Card>
  );
}

export function TokensCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [days, setDays] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const tokens = useQuery({
    queryKey: ["tokens"],
    queryFn: async () => (await unwrap(api.GET("/auth/tokens"))).items,
  });
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/auth/tokens", {
          body: { name, scopes, ...(days ? { expires_in_days: Number(days) } : {}) },
        }),
      ),
    onSuccess: (res) => {
      setSecret(res.secret);
      setName("");
      qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/auth/tokens/{id}", { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] }),
  });
  const errs = fieldErrors(create.error);

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">{t("account.tokens")}</h2>
      {secret && (
        <div className="space-y-1 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm">
          <p>{t("account.token_secret")}</p>
          <code className="block break-all font-mono text-accent">{secret}</code>
        </div>
      )}
      <ul className="divide-y divide-border">
        {tokens.data?.map((tk) => (
          <li key={tk.id} className="flex items-center gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{tk.name}</p>
              <p className="text-muted">
                <code>{tk.prefix}…</code> · {tk.scopes.join(", ")} · {timeAgo(tk.last_used_at, locale)}
              </p>
            </div>
            <Button variant="secondary" className="min-h-0 py-1 text-sm" onClick={() => revoke.mutate(tk.id)}>
              {t("common.delete")}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="space-y-3 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSecret(null);
          create.mutate();
        }}
      >
        <Field label={t("account.token_name")} error={errs.name}>
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <div className="flex flex-wrap gap-3 text-sm">
          {SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
              />
              <code>{s}</code>
            </label>
          ))}
        </div>
        {errs.scopes && <p className="text-sm text-danger">{errs.scopes}</p>}
        <Field label={t("account.token_expires")} error={errs.expires_in_days}>
          <Input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="sm:w-40" />
        </Field>
        <ErrorText error={Object.keys(errs).length ? null : (create.error ?? revoke.error)} />
        <Button type="submit" busy={create.isPending}>
          {t("account.token_create")}
        </Button>
      </form>
    </Card>
  );
}
