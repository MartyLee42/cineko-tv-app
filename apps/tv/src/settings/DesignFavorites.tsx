import { useState } from "react";
import { DESIGNS, useI18n, type DesignSetting } from "@martytv/ui";
import { DesignTile, SkinBackground } from "../design/skins";
import { OptionRows, ROW_GAP, ROW_H, useOptionKeys, type Row } from "./OptionList";

/** Toggles one design in the favourites (kept in picker order). */
export function toggleFavorite(favorites: readonly DesignSetting[], id: DesignSetting, on: boolean): DesignSetting[] {
  return DESIGNS.filter((d) => (d === id ? on : favorites.includes(d)));
}

/**
 * «Избранные оформления» (Settings → «Сюрприз»): one row per design, OK /
 * Left / Right stars or unstars it (saved at once); the focused design's tile
 * on the right. Opened over the Settings list; Back closes.
 */
export function DesignFavorites({ favorites, onChange, onClose }: { favorites: readonly DesignSetting[]; onChange: (next: DesignSetting[]) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [focused, setFocused] = useState<string>(DESIGNS[0]!);
  const rows: Row[] = DESIGNS.map((d) => ({
    kind: "choice",
    key: d,
    label: t(`settings.design.${d}`),
    choices: [
      { value: true, label: t("surprise.favorite_on") },
      { value: false, label: t("surprise.favorite_off") },
    ],
    value: favorites.includes(d),
    onChange: (v: unknown) => onChange(toggleFavorite(favorites, d, v === true)),
  }));
  const { index } = useOptionKeys({ rows, onBack: onClose, onFocusRow: setFocused, nested: true });
  const scroll = Math.max(0, (index - 5) * (ROW_H + ROW_GAP));
  const id = (DESIGNS as readonly string[]).includes(focused) ? (focused as DesignSetting) : DESIGNS[0]!;
  const note = favorites.length === 0 ? t("surprise.picker_none") : favorites.length === 1 ? t("surprise.picker_one") : t("surprise.favorites_count", { count: favorites.length, total: DESIGNS.length });

  return (
    <div data-testid="tv-design-favorites" className="absolute left-0 top-0 z-40 h-full w-full bg-bg">
      <SkinBackground dim />
      <div className="absolute left-[120px] top-[70px]">
        <h1 className="text-6xl font-bold">{t("surprise.favorites")}</h1>
        <p className="mt-3 text-2xl text-muted">{t("surprise.picker_hint")}</p>
      </div>
      <div className="absolute bottom-0 left-[120px] top-[200px] w-[1000px] overflow-hidden">
        <div className="tv-track pb-20" style={{ transform: `translate3d(0,${-scroll}px,0)` }}>
          <OptionRows rows={rows} index={index} action={0} />
        </div>
      </div>
      <aside className="absolute left-[1200px] right-[100px] top-[230px]">
        <DesignTile id={id} active width={560} star={favorites.includes(id)} />
        <p className="mt-6 text-2xl leading-snug text-muted">{t(`settings.design.${id}_hint`)}</p>
        <p data-testid="tv-design-favorites-note" className="mt-8 text-2xl leading-snug text-accent">
          {note}
        </p>
      </aside>
    </div>
  );
}
