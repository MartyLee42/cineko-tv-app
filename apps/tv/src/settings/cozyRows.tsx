// «Уютный режим» and «Живые постеры» on the TV Settings screen: the
// profile's cozy_mode, then (when on) the Home ambience and its quiet
// sound, and poster_wobble.
import { COZY_AMBIENCES, useI18n, type CozyAmbience } from "@martytv/ui";
import type { Settings } from "../profile/settings";
import type { Choice, Row } from "./OptionList";

export function useCozyRows(settings: Settings, set: (patch: Partial<Settings>) => void): Row[] {
  const { t } = useI18n();
  const onOff: Choice<unknown>[] = [
    { value: true, label: t("tv.settings.on") },
    { value: false, label: t("tv.settings.off") },
  ];
  const rows: Row[] = [
    {
      kind: "choice",
      key: "cozy_mode",
      label: t("cozy.title"),
      hint: t("cozy.hint"),
      choices: onOff,
      value: settings.cozy_mode,
      onChange: (v) => set({ cozy_mode: v as boolean }),
    },
  ];
  if (settings.cozy_mode) {
    rows.push({
      kind: "choice",
      key: "cozy_ambience",
      label: t("cozy.ambience"),
      hint: t("cozy.ambience_hint"),
      choices: COZY_AMBIENCES.map((a) => ({ value: a, label: t(`cozy.ambience.${a}`) })),
      value: settings.cozy_ambience,
      onChange: (v) => set({ cozy_ambience: v as CozyAmbience }),
    });
    if (settings.cozy_ambience !== "off")
      rows.push({
        kind: "choice",
        key: "cozy_sound",
        label: t("cozy.sound"),
        hint: t("cozy.sound_hint"),
        choices: onOff,
        value: settings.cozy_sound,
        onChange: (v) => set({ cozy_sound: v as boolean }),
      });
  }
  rows.push({
    kind: "choice",
    key: "poster_wobble",
    label: t("wobble.title"),
    hint: t("wobble.hint_tv"),
    choices: onOff,
    value: settings.poster_wobble,
    onChange: (v) => set({ poster_wobble: v as boolean }),
  });
  return rows;
}
