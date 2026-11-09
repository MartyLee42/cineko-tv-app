// «Семья советует» on the TV Settings screen: share_with_family (opt-in,
// default off) and show_family (default on); plus show_curated, the daily
// «Подборка» row on Home (default on).
import { useI18n } from "@martytv/ui";
import type { Settings } from "../profile/settings";
import type { Choice, Row } from "./OptionList";

export function useFamilyRows(settings: Settings, set: (patch: Partial<Settings>) => void): Row[] {
  const { t } = useI18n();
  const onOff: Choice<unknown>[] = [
    { value: true, label: t("tv.settings.on") },
    { value: false, label: t("tv.settings.off") },
  ];
  return [
    {
      kind: "choice",
      key: "share_with_family",
      label: t("family.share"),
      hint: `${t("family.share_hint")} ${t("familyvis.settings_note")}`,
      choices: onOff,
      value: settings.share_with_family,
      onChange: (v) => set({ share_with_family: v as boolean }),
    },
    {
      kind: "choice",
      key: "show_family",
      label: t("family.show"),
      hint: t("family.show_hint"),
      choices: onOff,
      value: settings.show_family,
      onChange: (v) => set({ show_family: v as boolean }),
    },
    {
      kind: "choice",
      key: "show_curated",
      label: t("curated.setting"),
      hint: t("curated.setting_hint"),
      choices: onOff,
      value: settings.show_curated,
      onChange: (v) => set({ show_curated: v as boolean }),
    },
  ];
}
