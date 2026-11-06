import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { Button, Card, ErrorText, timeAgo } from "../components";

/** Admin → Overview: the nightly «Новые серии» check (schedule, last runs, «Проверить сейчас»). */
export function NewEpisodesAdminCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "new-episodes"],
    queryFn: () => unwrap(api.GET("/admin/new-episodes")),
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 60_000),
  });
  const run = useMutation({
    mutationFn: () => unwrap(api.POST("/admin/new-episodes/run")),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["admin", "new-episodes"] }),
  });
  const st = q.data;
  const last = st?.runs[0];
  const running = !!st?.running || run.isPending;
  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">{t("newep.admin.title")}</h2>
        <Button variant="secondary" className="ml-auto min-h-[36px] text-sm" busy={running} onClick={() => run.mutate()}>
          {running ? t("newep.admin.running") : t("newep.admin.run")}
        </Button>
      </div>
      <ErrorText error={q.error ?? run.error} />
      {st && (
        <div className="space-y-1 text-sm text-muted">
          <p>{st.at === "off" ? t("newep.admin.off") : t("newep.admin.schedule", { at: st.at, tz: st.timezone })}</p>
          {st.next_run_at && <p>{t("newep.admin.next", { at: new Date(st.next_run_at).toLocaleString(locale) })}</p>}
          <p>
            {last
              ? t("newep.admin.last", {
                  at: timeAgo(last.started_at, locale),
                  trigger: last.trigger,
                  status: last.status,
                  series: last.series_checked,
                  found: last.found,
                  errors: last.refresh_errors,
                })
              : t("newep.admin.never")}
          </p>
          {last?.error && <p className="text-danger">{last.error}</p>}
        </div>
      )}
    </Card>
  );
}
