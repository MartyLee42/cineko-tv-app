// «Симметрия»: a pastel storybook in perfect symmetry. Powder pink ground,
// cream paper cards in mustard frames, mint stripes; the hero is a centred
// title card; each section opens with a small chapter card at the top centre
// («Часть 5 · Фильмы», looks/andersonChapter.ts). Everything is static except
// the chapter card's short fade-in (off in the calm mode).
import "./anderson.css";
import { useI18n } from "@martytv/ui";
import { useCalmMotion } from "../skins";
import type { MenuId } from "../menuOrder";
import type { Look } from "./types";
import { layer } from "./common";
import { chapterOf } from "./andersonChapter";

const CREAM = "#fbeee6";
const MUSTARD = "#d9a520";
const MINT = "#8fcfb8";

/** A scalloped awning: mint and cream stripes, symmetric about the centre. */
function Awning({ y, h }: { y: number; h: number }) {
  const n = 24;
  const w = 1920 / n;
  const scallops = Array.from({ length: n }, (_, i) => `M${i * w} ${y + h} a${w / 2} ${w / 3.2} 0 0 0 ${w} 0`).join(" ");
  return (
    <g>
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} x={i * w} y={y} width={w} height={h} fill={i % 2 ? CREAM : MINT} />
      ))}
      {Array.from({ length: n }, (_, i) => (
        <path key={i} d={`M${i * w} ${y + h} a${w / 2} ${w / 3.2} 0 0 0 ${w} 0 Z`} fill={i % 2 ? CREAM : MINT} />
      ))}
      <path d={scallops} fill="none" stroke={MUSTARD} strokeWidth="2" />
    </g>
  );
}

/** The set: pink wall, an awning along the top, a mustard double frame and a centred crest below. */
function SymmetryBackground({ dim }: { calm: boolean; dim: boolean }) {
  return (
    <div data-skin-bg="symmetry" className={`an-wall ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <Awning y={0} h={26} />
        <rect x="22" y="58" width="1876" height="1000" fill="none" stroke={MUSTARD} strokeWidth="3" />
        <rect x="32" y="68" width="1856" height="980" fill="none" stroke={MUSTARD} strokeWidth="1.2" opacity=".8" />
        {!dim && (
          <g transform="translate(960 1046)">
            <path d="M-60 0 H-14 M14 0 H60" stroke={MUSTARD} strokeWidth="2" />
            <path d="M0 -12 L12 0 L0 12 L-12 0 Z" fill={MINT} stroke={MUSTARD} strokeWidth="2" />
          </g>
        )}
      </svg>
    </div>
  );
}

/** Over Home's artwork: symmetric pink side panels and the awning (the picture reads as a set in a frame). */
function SymmetryHeroEdges({ height }: { height: number }) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0" width="1920" height={height} viewBox={`0 0 1920 ${height}`} aria-hidden>
      <Awning y={0} h={26} />
      <rect x="22" y="58" width="1876" height={height - 80} fill="none" stroke={CREAM} strokeWidth="3" opacity=".9" />
    </svg>
  );
}

/** «Часть N · <tab>»: a small cream card at the top centre of every section (fades in when the section changes).
 *  Home has room for two lines; elsewhere it is one slim line above the screen's own title. */
function ChapterCard({ onHome, section }: { onHome: boolean; section: MenuId | null }) {
  const { t } = useI18n();
  const calm = useCalmMotion();
  const ch = chapterOf(section);
  if (!ch) return null;
  return (
    <div className={`pointer-events-none absolute left-0 z-[19] w-[1920px] text-center ${onHome ? "top-[150px]" : "top-[144px]"}`}>
      <div key={section} data-testid="an-chapter" className={`an-chapter ${onHome ? "" : "an-chapter-line"} ${calm ? "" : "an-chapter-in"}`}>
        <span className="an-chapter-n">{t("anderson.chapter", { n: ch.n })}</span>
        <span className="an-chapter-name">{t(ch.nameKey)}</span>
      </div>
    </div>
  );
}

export const look: Look = { Background: SymmetryBackground, HeroEdges: SymmetryHeroEdges, Companion: ChapterCard };
