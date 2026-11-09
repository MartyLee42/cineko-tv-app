// «Новая волна»: a black screen edged with solid colour cards — a red card with «КИНО» set
// sideways and a blue one under it with a pencilled note (the left margin of wide windows; on
// phones two slim bars); a white card on the right edge. Static.
import { useI18n } from "@martytv/ui";
import type { WebLook } from "../look";
import "./vague.css";

function Scene() {
  const { t } = useI18n();
  return (
    <div className="nv-scene wd-fill">
      <div className="nv-card nv-red">
        <span className="nv-side">{t("designs.vague.side")}</span>
      </div>
      <div className="nv-card nv-blue">
        <span className="nv-side nv-note">{t("designs.vague.note")}</span>
      </div>
      <div className="nv-white wd-wide" />
    </div>
  );
}

/** Over Home's hero: a red and a blue bar cut into the artwork's edges, like a jump-cut frame. */
function HeroEdges() {
  return (
    <>
      <span className="nv-hero-red" />
      <span className="nv-hero-blue" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };
