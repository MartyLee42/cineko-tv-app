// «Праздничные анимации» on the web Settings page (per profile) with a
// 10-second preview of any holiday, and the admin's global switch.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import {
  SEASONAL_SETTINGS,
  SEASONS,
  startSeasonPreview,
  stopSeasonPreview,
  useI18n,
  useSeasonPreview,
  useTodaySeasonState,
  type MessageKey,
  type SeasonId,
  type SeasonalSetting,
} from "@martytv/ui";
import { api } from "../api";
import { Button, Card, ErrorText, Select } from "../components";
import { useSeasonalAllowed } from "./SeasonalLayer";

export function SeasonalSetting({ value, onChange }: { value: SeasonalSetting; onChange: (v: SeasonalSetting) => void }) {
  const { t } = useI18n();
  const allowed = useSeasonalAllowed();
  const today = useTodaySeasonState();
  const [pick, setPick] = useState<SeasonId>(today?.id ?? "newyear");
  const running = useSeasonPreview();
  return (
    <div className="space-y-3 rounded-xl border border-border px-3.5 py-3" data-testid="setting-seasonal">
      <label className="block">
        <span className="block font-medium">{t("seasons.setting")}</span>
        <span className="mt-0.5 block text-xs text-muted">{allowed ? t("seasons.setting_hint") : t("seasons.admin_disabled")}</span>
        <Select
          className="mt-2 sm:w-72"
          value={value}
          disabled={!allowed}
          onChange={(e) => onChange(e.target.value as SeasonalSetting)}
          data-testid="seasonal-select"
          aria-label={t("seasons.setting")}
        >
          {SEASONAL_SETTINGS.map((v) => (
            <option key={v} value={v}>
              {t(`seasons.mode.${v}`)}
            </option>
          ))}
        </Select>
      </label>
      {allowed && (
        <div>
          <span className="block text-sm text-muted">{t("seasons.preview")}</span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Select className="sm:w-72" value={pick} onChange={(e) => setPick(e.target.value as SeasonId)} data-testid="season-preview-select" aria-label={t("seasons.preview")}>
              {SEASONS.map((id) => (
                <option key={id} value={id}>
                  {t(`seasons.name.${id}` as MessageKey)}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="secondary"
              data-testid="season-preview-button"
              onClick={() => (running === pick ? stopSeasonPreview() : startSeasonPreview(pick))}
            >
              {running === pick ? t("seasons.preview_running") : t("seasons.preview_button")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Admin: holiday animations on/off for everyone (/admin/appearance, shown to readers in /status). */
export function SeasonalAdminCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "appearance"], queryFn: () => unwrap(api.GET("/admin/appearance")) });
  const save = useMutation({
    mutationFn: (on: boolean) => unwrap(api.PUT("/admin/appearance", { body: { seasonal_effects: on } })),
    onSuccess: (data) => {
      qc.setQueryData(["admin", "appearance"], data);
      void qc.invalidateQueries({ queryKey: ["service-status"] });
    },
  });
  const on = q.data?.seasonal_effects ?? true;
  return (
    <Card className="space-y-2" >
      <h2 className="text-lg font-bold">{t("seasons.admin.title")}</h2>
      <p className="text-sm text-muted">{t("seasons.admin.hint")}</p>
      <Select
        className="sm:w-72"
        value={on ? "on" : "off"}
        disabled={q.isPending || save.isPending}
        onChange={(e) => save.mutate(e.target.value === "on")}
        data-testid="admin-seasonal-select"
        aria-label={t("seasons.admin.title")}
      >
        <option value="on">{t("seasons.admin.on")}</option>
        <option value="off">{t("seasons.admin.off")}</option>
      </Select>
      <ErrorText error={q.error ?? save.error} />
    </Card>
  );
}
