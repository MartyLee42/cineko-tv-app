// «Репликант»: a neo-noir homage (original drawings only). A megacity in violet fog under a giant pink
// hologram of Cineko, a lone figure on the wet walkway, rain (the one animated layer, with the
// hologram's flicker; both stop when calm) — @martytv/ui decor/replicant. Over Home's hero: scanlines,
// a pink-to-cyan grade and an oscilloscope trace along the foot. Details' title is a specimen readout
// with an amber spectral band; OK on a card glitches it like a hologram losing signal; a row ends on
// «Конец записи» with a flatlining trace. Cards and chrome in replicant.css.
import "./replicant.css";
import type { ReactNode } from "react";
import { useI18n } from "@martytv/ui";
import { oscilloscope } from "@martytv/ui/decor";
import { HoloCity, SpectralBand } from "@martytv/ui/decor/replicant";
import type { Look } from "./types";
import { layer } from "./common";

/** The fog city with the hologram; lists and grids put text anywhere, so a violet veil keeps it a backdrop. */
function Hologram({ calm, dim }: { calm: boolean; dim: boolean }) {
  return (
    <div data-skin-bg="hologram" data-motion={calm ? "calm" : "on"} className={`rp-ground ${layer}`}>
      <HoloCity calm={calm} dim={dim} className="absolute left-0 top-0" />
      <div className={`rp-veil absolute left-0 top-0 h-full w-full ${dim ? "rp-veil-dim" : ""}`} />
    </div>
  );
}

/** Over Home's hero artwork: scanlines, a hologram grade and a faint oscilloscope along the foot. */
function HeroEdges({ height }: { height: number }) {
  const trace = oscilloscope(0, 1320, height - 34, 22, 7, 0.55);
  return (
    <>
      <div className="rp-grade pointer-events-none absolute left-0 top-0 h-full w-full" />
      <div className="rp-scanlines pointer-events-none absolute left-0 top-0 h-full w-full" />
      <svg className="pointer-events-none absolute left-0 top-0" width="1320" height={height} viewBox={`0 0 1320 ${height}`} aria-hidden>
        <path d={trace} fill="none" stroke="#ff7a2a" strokeWidth="6" opacity=".35" />
        <path d={trace} fill="none" stroke="#ffd9a8" strokeWidth="2" opacity=".6" />
      </svg>
    </>
  );
}

/** Details: the title as a specimen readout — «Образец · Фильм», the title, an amber spectral band. */
function SpecimenPlate({ children, kind }: { children: ReactNode; kind: string }) {
  const { t } = useI18n();
  return (
    <div data-testid="specimen-plate" className="rp-plate relative mt-2">
      <p className="rp-plate-label">
        {t("replicant.specimen")} · {kind}
      </p>
      {children}
      <div className="rp-plate-scan">
        <SpectralBand width={640} height={64} digits={false} />
        <span className="rp-plate-caption">{t("replicant.scan")}</span>
      </div>
    </div>
  );
}

/** OK on a card: a hologram glitch — jitter, a chromatic split, signal bands sweeping (≤ ¼ s), then Details. */
const glitch = {
  ms: 260,
  start(card: HTMLElement) {
    card.classList.add("rp-glitch");
    setTimeout(() => card.classList.remove("rp-glitch"), 700);
  },
};

/** The trace at a row's end: a pulse that dies out into a flatline (260 × 80). */
const FLAT = Array.from({ length: 66 }, (_, i) => {
  const x = i * 4;
  const y = 40 - Math.sin((x / 260) * Math.PI * 8) * 30 * Math.max(0, 1 - x / 170);
  return `${i ? "L" : "M"}${x} ${y.toFixed(1)}`;
}).join(" ");

/** After a row's last card and under grids: «Конец записи», a trace flatlining, the signal lost in the rain. */
function EndOfRecord({ kind, width, height }: { kind: "row" | "screen"; width: number; height: number }) {
  const { t } = useI18n();
  return (
    <div data-testid="rp-end" className="rp-end-wrap" style={{ width, height: kind === "row" ? height : 200 }}>
      <div className="rp-end">
        <svg width="260" height="80" viewBox="0 0 260 80" aria-hidden className="rp-end-trace">
          <path d={FLAT} fill="none" stroke="#ff7a2a" strokeWidth="6" opacity=".45" />
          <path d={FLAT} fill="none" stroke="#ffd9a8" strokeWidth="2" />
        </svg>
        <p className="rp-end-text">{t("replicant.end")}</p>
        <p className="rp-end-note">{t("replicant.end_note")}</p>
      </div>
    </div>
  );
}

export const look: Look = { Background: Hologram, HeroEdges, TitlePlate: SpecimenPlate, pick: glitch, End: EndOfRecord };
