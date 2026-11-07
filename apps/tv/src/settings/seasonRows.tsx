// «Праздничные анимации» on the TV Settings screen: the profile's
// seasonal_effects (on / calm / off) and a preview row whose choices are
// the holidays; while it is focused the aside plays the chosen one for 10 s
// on a scaled-down 1920×1080 canvas, then holds it still.
import { useEffect, useState } from "react";
import { SeasonPreviewBox } from "@martytv/ui/season-layer";
import { SEASONAL_SETTINGS, SEASONS, PREVIEW_MS, useI18n, useReducedMotion, type MessageKey, type SeasonId, type SeasonalSetting } from "@martytv/ui";
import { useServerStatus } from "../design/data";
import { useTodaySeason } from "../design/season";
import { useCalmMotion } from "../design/skins";
import type { Settings } from "../profile/settings";
import type { Row } from "./OptionList";

export const SEASON_ROW = "seasonal_effects";
export const SEASON_PREVIEW_ROW = "season_preview";

export function useSeasonRows(settings: Settings, set: (patch: Partial<Settings>) => void) {
  const { t } = useI18n();
  const today = useTodaySeason();
  const [preview, setPreview] = useState<SeasonId>(today ?? "newyear");
  const admin = useServerStatus().data?.seasonal_effects !== false;
  const rows: Row[] = [
    {
      kind: "choice",
      key: SEASON_ROW,
      label: t("seasons.setting"),
      hint: admin ? t("seasons.setting_hint") : t("seasons.admin_disabled"),
      choices: SEASONAL_SETTINGS.map((v) => ({ value: v, label: t(`seasons.mode.${v}`) })),
      value: settings.seasonal_effects,
      onChange: (v) => set({ seasonal_effects: v as SeasonalSetting }),
    },
    {
      kind: "choice",
      key: SEASON_PREVIEW_ROW,
      label: t("seasons.preview"),
      hint: t("seasons.preview_hint"),
      choices: SEASONS.map((id) => ({ value: id, label: t(`seasons.name.${id}` as MessageKey) })),
      value: preview,
      onChange: (v) => setPreview(v as SeasonId),
    },
  ];
  return { rows, preview };
}

/** The aside preview: animated for 10 s after each change (still in calm mode), then still. */
export function SeasonPreviewPanel({ season, setting, width = 620 }: { season: SeasonId; setting: SeasonalSetting; width?: number }) {
  const { t } = useI18n();
  const calm = useCalmMotion();
  const reduced = useReducedMotion();
  const [running, setRunning] = useState(true);
  // Keyed by season (SettingsScreen), so each choice restarts the 10 s.
  useEffect(() => {
    const id = setTimeout(() => setRunning(false), PREVIEW_MS);
    return () => clearTimeout(id);
  }, []);
  const still = !running || setting === "calm" || calm || reduced;
  return (
    <div data-testid="tv-season-preview" data-season={season}>
      <p className="text-4xl font-semibold">{t(`seasons.name.${season}` as MessageKey)}</p>
      <p className="mb-6 mt-4 text-2xl leading-snug text-muted">{t("seasons.preview_hint")}</p>
      <div className="overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <SeasonPreviewBox key={season} season={season} mode={still ? "static" : "full"} width={width} />
      </div>
    </div>
  );
}
