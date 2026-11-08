// Admin → «Инциденты»: outage incidents (open + last 30 days) and this
// device's Web Push opt-in («Уведомления о сбоях»). Server: internal/alerts.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { Spinner, StatusDot, useI18n } from "@martytv/ui";
import { api, realtime } from "../api";
import { Button, Card, ErrorText } from "../components";
import { base64UrlToBytes, durationParts, keyChanged, pushSupport, splitIncidents, subscriptionBody, type Incident } from "./alerts";

const KEY = ["admin", "incidents"] as const;

/** Open incidents (the tab badge); refreshes every minute and on new messages. */
export function useIncidents(lang: string) {
  const qc = useQueryClient();
  useEffect(
    () =>
      realtime.on((env) => {
        if (env.type === "message") void qc.invalidateQueries({ queryKey: KEY });
      }),
    [qc],
  );
  return useQuery({
    queryKey: [...KEY, lang],
    queryFn: () => unwrap(api.GET("/admin/incidents", { params: { query: { lang } } })),
    refetchInterval: 60_000,
  });
}

export function IncidentsTab() {
  const { t, locale } = useI18n();
  const q = useIncidents(locale);
  const { open, closed } = splitIncidents(q.data?.items ?? []);
  return (
    <div className="space-y-4" data-testid="incidents-tab">
      <PushCard />
      <Card>
        <h2 className="text-lg font-semibold">{t("alerts.title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("alerts.hint")}</p>
        <ErrorText error={q.error} />
        {q.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : open.length + closed.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t("alerts.empty")}</p>
        ) : (
          <>
            {open.length > 0 && <IncidentList title={t("alerts.open")} items={open} />}
            {closed.length > 0 && <IncidentList title={t("alerts.recent")} items={closed} />}
          </>
        )}
      </Card>
    </div>
  );
}

function IncidentList({ title, items }: { title: string; items: Incident[] }) {
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-sm font-medium text-muted">{title}</h3>
      <ul className="divide-y divide-border">
        {items.map((x) => (
          <IncidentRow key={x.id} x={x} />
        ))}
      </ul>
    </div>
  );
}

function IncidentRow({ x }: { x: Incident }) {
  const { t, locale } = useI18n();
  const p = durationParts(x);
  const dur = p.d > 0 ? t("alerts.days", { d: p.d, h: p.h }) : p.h > 0 ? t("alerts.hours", { h: p.h, m: p.m }) : t("alerts.minutes", { n: p.m });
  const when = new Date(x.opened_at).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <li className="flex items-start gap-3 py-3" data-testid="incident-row">
      <span className="mt-1.5">
        <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${x.closed_at ? "bg-ok" : "bg-danger"}`} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{x.summary}</p>
        {x.notes.length > 0 && <p className="mt-0.5 text-sm text-muted">{x.notes.join(" ")}</p>}
        <p className="mt-0.5 text-xs text-muted">
          {t("alerts.since", { when })} · {x.closed_at ? t("alerts.lasted", { d: dur }) : t("alerts.lasting", { d: dur })} ·{" "}
          {t(x.source === "host" ? "alerts.source.host" : "alerts.source.monitor")}
          {x.reminders > 0 && <> · {t("alerts.reminders", { n: x.reminders })}</>}
        </p>
        {x.detail && <p className="mt-0.5 break-words font-mono text-[11px] text-muted">{x.detail}</p>}
      </div>
    </li>
  );
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** «Уведомления о сбоях» on this device: the browser's push subscription, mirrored on the server. */
function PushCard() {
  const { t, locale } = useI18n();
  const support = pushSupport(window as unknown as Parameters<typeof pushSupport>[0]);
  const status = useQuery({
    queryKey: ["admin", "alerts-push"],
    queryFn: () => unwrap(api.GET("/admin/alerts/push")),
    enabled: support === "supported",
  });
  const [on, setOn] = useState<boolean | null>(null);
  const [denied, setDenied] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  const serverKey = status.data?.public_key;

  // Mirror an existing subscription on the server (idempotent; refreshes the language).
  useEffect(() => {
    if (support !== "supported" || !serverKey) return;
    let cancelled = false;
    void (async () => {
      const sub = await currentSubscription().catch(() => null);
      if (cancelled) return;
      if (sub && keyChanged(sub.options.applicationServerKey, serverKey)) {
        await sub.unsubscribe().catch(() => false);
        setOn(false);
        return;
      }
      setOn(!!sub);
      const body = sub && subscriptionBody(sub.toJSON(), locale);
      if (body) await api.POST("/admin/alerts/push", { body }).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [support, serverKey, locale]);

  const toggle = useMutation({
    mutationFn: async (enable: boolean) => {
      setSent(null);
      if (!enable) {
        const sub = await currentSubscription();
        if (sub) {
          await unwrap(api.POST("/admin/alerts/push/unsubscribe", { body: { endpoint: sub.endpoint } }));
          await sub.unsubscribe();
        }
        return false;
      }
      if (!serverKey) throw new Error(t("alerts.push.failed"));
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setDenied(true);
        return false;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(serverKey) });
      const body = subscriptionBody(sub.toJSON(), locale);
      if (!body) throw new Error(t("alerts.push.failed"));
      await unwrap(api.POST("/admin/alerts/push", { body }));
      return true;
    },
    onSuccess: (v) => setOn(v),
  });
  const test = useMutation({
    mutationFn: () => unwrap(api.POST("/admin/alerts/push/test")),
    onSuccess: (r) => setSent(r.sent),
  });

  return (
    <Card>
      <h2 className="text-lg font-semibold">{t("alerts.push.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("alerts.push.hint")}</p>
      {support !== "supported" ? (
        <p className="mt-3 text-sm text-muted">{t(support === "insecure" ? "alerts.push.insecure" : "alerts.push.unsupported")}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-sm">
            <StatusDot online={!!on} />
            {t(on ? "alerts.push.on" : "alerts.push.off")}
          </span>
          {on === null ? (
            <Spinner />
          ) : (
            <Button variant={on ? "secondary" : "primary"} busy={toggle.isPending} onClick={() => toggle.mutate(!on)} data-testid="push-toggle">
              {t(on ? "alerts.push.disable" : "alerts.push.enable")}
            </Button>
          )}
          {on && (
            <Button variant="secondary" busy={test.isPending} onClick={() => test.mutate()}>
              {t("alerts.push.test")}
            </Button>
          )}
          {sent !== null && <span className="text-sm text-muted">{t("alerts.push.test_sent", { n: sent })}</span>}
        </div>
      )}
      {denied && <p className="mt-2 text-sm text-warn">{t("alerts.push.denied")}</p>}
      <ErrorText error={status.error ?? toggle.error ?? test.error} />
    </Card>
  );
}
