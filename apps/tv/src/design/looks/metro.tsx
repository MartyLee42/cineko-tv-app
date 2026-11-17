// «Метро»: a metro map at night (original drawing, no real network). Every row is a line of its
// own colour with a station under each poster (metro.css, from the rows' data-line); the Details
// title hangs on a station sign; a row ends at «Конечная». Static: no animated layers.
import "./metro.css";
import type { ReactNode } from "react";
import { useI18n } from "@martytv/ui";
import type { Look } from "./types";
import { layer } from "./common";

/** The line colours, in the rows' order (data-line 0…10, see LINE_COLOURS); metro.css repeats them. */
export const METRO_LINES = ["#d52028", "#1fa046", "#0078bf", "#19c1f3", "#8d5b2d", "#f07e20", "#8e479c", "#ffcd1c", "#a1a2a3", "#b4d445", "#79cdcd"] as const;

/** One line of the background schematic: a polyline with 45° bends, its stations at some of the points. */
interface MapLine {
  colour: string;
  d: string;
  stations: [number, number][];
}

// A made-up network drawn on a 1920×1080 grid: four radial lines, a ring and a short branch.
const RING = { cx: 1290, cy: 560, r: 300 };
const LINES: MapLine[] = [
  { colour: METRO_LINES[0], d: "M640 120 L900 120 L1100 320 L1480 700 L1480 1080", stations: [[900, 120], [1100, 320], [1290, 510], [1480, 700], [1480, 880]] },
  { colour: METRO_LINES[1], d: "M1920 260 L1700 260 L1450 510 L1130 510 L860 780 L560 780", stations: [[1700, 260], [1450, 510], [1130, 510], [860, 780]] },
  { colour: METRO_LINES[2], d: "M1290 0 L1290 860 L1060 1080", stations: [[1290, 140], [1290, 260], [1290, 700], [1290, 860]] },
  { colour: METRO_LINES[5], d: "M1920 900 L1660 900 L1520 760 L1060 760 L900 600 L900 380", stations: [[1660, 900], [1520, 760], [1060, 760], [900, 380]] },
  { colour: METRO_LINES[6], d: "M1760 1080 L1760 560 L1590 390 L1590 160", stations: [[1760, 760], [1590, 390], [1590, 160]] },
];

/** The schematic, faint behind everything: lines, the ring, stations (white with the line's ring). */
function MetroMap({ dim }: { dim: boolean }) {
  return (
    <div data-skin-bg="metromap" className={`mx-ground ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden style={{ opacity: dim ? 0.1 : 0.22 }}>
        <circle cx={RING.cx} cy={RING.cy} r={RING.r} fill="none" stroke={METRO_LINES[4]} strokeWidth="16" />
        <g fill="none" strokeWidth="16" strokeLinejoin="round" strokeLinecap="round">
          {LINES.map((l) => (
            <path key={l.colour} d={l.d} stroke={l.colour} />
          ))}
        </g>
        {LINES.map((l) =>
          l.stations.map(([x, y]) => <circle key={`${l.colour}${x}-${y}`} cx={x} cy={y} r="13" fill="#f0f2f5" stroke={l.colour} strokeWidth="7" />),
        )}
        {[0, 60, 120, 180, 240, 300].map((a) => {
          const rad = (a * Math.PI) / 180;
          return <circle key={a} cx={RING.cx + RING.r * Math.cos(rad)} cy={RING.cy + RING.r * Math.sin(rad)} r="13" fill="#f0f2f5" stroke={METRO_LINES[4]} strokeWidth="7" />;
        })}
      </svg>
    </div>
  );
}

/** The red «M» roundel (drawn; no real operator's logo). */
export function Roundel({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className="shrink-0">
      <circle cx="24" cy="24" r="23" fill="#d52028" />
      <path d="M10 34 L17 13 L24 27 L31 13 L38 34" fill="none" stroke="#fff" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Details: the title on a station sign — the roundel, «СТАНЦИЯ · ФИЛЬМ» and the name. */
function StationSign({ children, kind }: { children: ReactNode; kind: string }) {
  const { t } = useI18n();
  return (
    <div data-testid="station-sign" className="mx-sign relative mt-3 flex items-center pb-[18px] pl-[28px] pr-[44px] pt-[16px]">
      <Roundel size={84} />
      <div className="ml-[26px] min-w-0">
        <p className="mx-sign-label">
          {t("metro.station")} · {kind}
        </p>
        {children}
      </div>
    </div>
  );
}

/** A row's end (and a grid's foot): the line stops at a bar, «Конечная · Поезд дальше не идёт». */
function Terminus({ kind, width, height }: { kind: "row" | "screen"; width: number; height: number }) {
  const { t } = useI18n();
  const w = kind === "row" ? Math.min(width, 300) : 420;
  return (
    <div data-testid="metro-end" className="mx-end-wrap" style={{ width, height: kind === "row" ? height : 200 }}>
      <div className="mx-end" style={{ width: w }}>
        <span className="mx-end-bar" />
        <p className="mx-end-text">{t("metro.terminus")}</p>
        <p className="mx-end-note">{t("metro.terminus_note")}</p>
      </div>
    </div>
  );
}

export const look: Look = { Background: ({ dim }) => <MetroMap dim={dim} />, TitlePlate: StationSign, End: Terminus };
