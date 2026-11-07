// «Новая волна»: a black screen edged with solid colour cards and a pencilled margin note.
import "./vague.css";
import { useI18n } from "@martytv/ui";
import type { Look } from "./types";
import { layer } from "./common";

/**
 * Static. Screens keep the left margin (x < 86) free, so the cards live there:
 * a red card with «КИНО» set sideways and a blue one under it with a
 * handwritten note.
 */
function Cards({ dim }: { dim: boolean }) {
  const { t } = useI18n();
  return (
    <div data-skin-bg="cards" className={`nv-ground ${layer}`} style={{ opacity: dim ? 0.4 : 1 }}>
      <div className="absolute" style={{ left: 0, top: 168, width: 58, height: 430, background: "#e6281e" }}>
        <span className="nv-side">{t("designs.vague.side")}</span>
      </div>
      <div className="absolute" style={{ left: 0, top: 598, width: 58, height: 438, background: "#345cde" }}>
        <span className="nv-side nv-side-note">{t("designs.vague.note")}</span>
      </div>
    </div>
  );
}

export const look: Look = { Background: ({ dim }) => <Cards dim={dim} /> };
