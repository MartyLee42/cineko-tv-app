// The design pickers' preview tiles (Settings, the first-run guide, «Сюрприз»
// favourites): every design drawn small in its own colours. Only the settings
// chunk imports this, so the tiles' CSS (previews.css) stays out of the startup CSS.
import { DESIGN_SWATCH, DESIGNS, useI18n, type DesignSetting } from "@martytv/ui";
import { skinOf } from "./registry";
import "./previews.css";

/** A small tile drawn in a design's own colours (Settings / first-run guide). */
export function DesignTile({ id, active, width = 196, star = false }: { id: DesignSetting; active: boolean; width?: number; star?: boolean }) {
  const { t } = useI18n();
  const sw = DESIGN_SWATCH[id];
  const h = Math.round(width * 0.5625);
  return (
    <div data-design-tile={id} data-active={active ? "1" : undefined} className="mb-[14px] mr-[14px] inline-block align-top" style={{ width }}>
      <div className={`dt-tile dt-${id} relative overflow-hidden ${active ? "dt-on" : ""}`} style={{ width, height: h, background: sw.bg }}>
        {/* Mini layout: nav strip per skeleton, a hero bar and three posters. */}
        <span className={`dt-nav dt-nav-${skinOf(id).skeleton}`} style={{ background: sw.surface }} />
        <span className="dt-title" style={{ background: sw.text }} />
        <span className="dt-accent" style={{ background: sw.accent }} />
        {[0, 1, 2].map((i) => (
          <span key={i} className="dt-poster" style={{ left: `${30 + i * 20}%`, borderColor: i === 0 ? sw.accent2 : sw.surface, background: sw.surface }} />
        ))}
        {/* «Сюрприз»: a favourite. */}
        {star && (
          <span data-star="1" className="absolute right-[8px] top-[2px] text-[26px] leading-none" style={{ color: sw.accent, textShadow: "0 1px 3px rgba(0,0,0,.8)" }}>
            ★
          </span>
        )}
      </div>
      <p className={`mt-2 truncate text-[20px] ${active ? "font-bold text-text" : "text-muted"}`}>{t(`settings.design.${id}`)}</p>
    </div>
  );
}

/** Every design's tile, the current one highlighted (and «Сюрприз» favourites starred). */
export function DesignPreviews({ current, width = 196, stars }: { current: DesignSetting; width?: number; stars?: readonly DesignSetting[] }) {
  return (
    <div data-testid="design-previews" style={{ width: (width + 14) * 3 }}>
      {DESIGNS.map((d) => (
        <DesignTile key={d} id={d} active={d === current} width={width} star={!!stars?.includes(d)} />
      ))}
    </div>
  );
}
