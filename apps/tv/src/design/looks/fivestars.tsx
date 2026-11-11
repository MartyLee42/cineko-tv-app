// «Пять звёзд»: an homage to 80s open-world crime games (original drawings only). The background is
// a fan's desk: a purple grid under a sticker collage — a pink brush-script «Cineko», a blue comic bay
// in cel-shaded duotone, a pink «wanted» poster, an orange postcard, rounded stickers (decor/collage).
// On the projector layout, like «Каркас». Cards are white-bordered stickers (fivestars.css); OK on a
// card is a camera switch (a quick push-in with a white flash); a row ends on «Миссия выполнена». The
// clock is a game HUD with five wanted stars (fivestars.css). The one animated layer: glints on the
// bay's water (stopped when calm).
import "./fivestars.css";
import { useI18n } from "@martytv/ui";
import { StickerDesk } from "@martytv/ui/decor/collage";
import type { Look } from "./types";
import { layer } from "./common";

/** The desk: a purple grid under the sticker collage (decor/collage.tsx). `dim` (Settings, guide): the grid and a faint script only. */
function Desk({ calm, dim }: { calm: boolean; dim: boolean }) {
  return (
    <div data-skin-bg="sunset" className={`fs-desk ${layer}`}>
      <StickerDesk calm={calm} dim={dim} className="absolute left-0 top-0" />
    </div>
  );
}

/** Over Home's full-screen artwork: a duotone grade, a halftone corner and a diagonal gutter, like a panel of the box art. */
function HeroGrade({ height }: { height: number }) {
  return (
    <>
      <div className="fs-grade pointer-events-none absolute left-0 top-0 h-full w-full" />
      <div className="fs-dots pointer-events-none absolute right-0 top-0" />
      <svg className="pointer-events-none absolute left-0 top-0" width="1920" height={height} viewBox={`0 0 1920 ${height}`} aria-hidden>
        <path d={`M1760 0 L1812 0 L${1812 - height * 0.2} ${height} L${1760 - height * 0.2} ${height} Z`} fill="#0e0a24" />
        <path d={`M1760 0 L1768 0 L${1768 - height * 0.2} ${height} L${1760 - height * 0.2} ${height} Z M1804 0 L1812 0 L${1812 - height * 0.2} ${height} L${1804 - height * 0.2} ${height} Z`} fill="#ffffff" />
      </svg>
    </>
  );
}

/** OK on a card: a camera switch — a quick push-in and a white flash (≤ ¼ s), then Details. */
const cameraSwitch = {
  ms: 240,
  start(card: HTMLElement) {
    card.classList.add("fs-switch");
    setTimeout(() => card.classList.remove("fs-switch"), 700);
  },
};

/** After a row's last card and under grids: «Миссия выполнена», «Уважение +». Static. */
function MissionPassed({ kind, width, height }: { kind: "row" | "screen"; width: number; height: number }) {
  const { t } = useI18n();
  const text = t("fivestars.passed");
  const cut = text.indexOf(" ");
  return (
    <div data-testid="fs-end" className="fs-end-wrap" style={{ width, height: kind === "row" ? height : 200 }}>
      <div className="fs-end">
        <p className="fs-end-text">
          {kind === "row" && cut > 0 ? (
            <>
              {text.slice(0, cut)}
              <br />
              {text.slice(cut + 1)}
            </>
          ) : (
            text
          )}
        </p>
        <p className="fs-end-respect">{t("fivestars.respect")}</p>
      </div>
    </div>
  );
}

export const look: Look = { Background: Desk, HeroEdges: HeroGrade, pick: cameraSwitch, End: MissionPassed };
