// Admin → Сервер: the Invidious card (reachable, version, latency, last
// error, feed stats; «Проверить» probes now).
import type { ReactNode } from "react";
import { Spinner, StatusDot, useI18n } from "@martytv/ui";
import { Button, Card, ErrorText, timeAgo } from "../components";
import { useAdminVideoStatus, useCheckVideo } from "./queries";

export function AdminVideoCard() {
  const { t, locale } = useI18n();
  const q = useAdminVideoStatus();
  const check = useCheckVideo();
  const s = check.data && q.data && Date.parse(check.data.checked_at ?? "") >= Date.parse(q.data.checked_at ?? "") ? check.data : q.data;
  const when = (iso: string | null) => (iso ? timeAgo(iso, locale) : t("video.web.admin.never"));

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-semibold">{t("video.admin.title")}</h2>
        {s?.configured && (
          <Button variant="secondary" className="!min-h-[36px] text-sm" busy={check.isPending} onClick={() => check.mutate()} data-testid="admin-video-check">
            {t("video.admin.check")}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Spinner />
      ) : !s ? (
        <ErrorText error={q.error} />
      ) : !s.configured ? (
        <p className="text-sm text-muted" data-testid="admin-video-state">
          {t("video.admin.not_configured")}
        </p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm font-semibold" data-testid="admin-video-state">
            <StatusDot online={s.reachable === true} />
            {s.reachable == null ? t("video.web.admin.not_checked") : s.reachable ? t("video.admin.reachable") : t("video.admin.unreachable")}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3" data-testid="admin-video">
            <Item label={t("video.admin.version")} value={s.version ?? "—"} mono />
            <Item label={t("video.admin.latency")} value={s.latency_ms != null ? t("video.web.admin.ms", { ms: s.latency_ms }) : "—"} />
            <Item label={t("video.web.admin.checked")} value={when(s.checked_at)} />
            <Item label={t("video.web.admin.last_ok")} value={when(s.last_ok_at)} />
            <Item label={t("video.admin.subscriptions")} value={s.subscriptions} />
            <Item label={t("video.web.admin.channels")} value={s.channels} />
            <Item label={t("video.web.admin.feed_videos")} value={s.feed_videos} />
            <Item label={t("video.admin.feed")} value={when(s.feed_refreshed_at)} />
          </dl>
          {s.last_error && (
            <p className="break-words rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="admin-video-error">
              {t("video.admin.last_error")}: {s.last_error}
              {s.last_error_at && <span className="text-muted"> · {timeAgo(s.last_error_at, locale)}</span>}
            </p>
          )}
        </>
      )}
      <ErrorText error={check.error} />
    </Card>
  );
}

function Item({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`truncate font-semibold ${mono ? "font-mono text-xs font-normal" : ""}`}>{value}</dd>
    </div>
  );
}
