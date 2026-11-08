// Admin → Server: «Мгновенный старт» on/off (/admin/playback; services/api playback/warm.go).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { Card, ErrorText, Select } from "../components";

export function InstantPlayCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "playback"], queryFn: () => unwrap(api.GET("/admin/playback")) });
  const save = useMutation({
    mutationFn: (on: boolean) => unwrap(api.PUT("/admin/playback", { body: { instant_play: on } })),
    onSuccess: (data) => qc.setQueryData(["admin", "playback"], data),
  });
  const on = q.data?.instant_play ?? true;
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold">{t("instantplay.admin.title")}</h2>
      <p className="text-sm text-muted">{t("instantplay.admin.hint")}</p>
      <Select
        className="sm:w-72"
        value={on ? "on" : "off"}
        disabled={q.isPending || save.isPending}
        onChange={(e) => save.mutate(e.target.value === "on")}
        data-testid="admin-instant-play"
        aria-label={t("instantplay.admin.title")}
      >
        <option value="on">{t("instantplay.admin.on")}</option>
        <option value="off">{t("instantplay.admin.off")}</option>
      </Select>
      <ErrorText error={q.error ?? save.error} />
    </Card>
  );
}
