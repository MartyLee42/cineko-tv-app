// «Пять звёзд»: a fan's desk — a purple grid under a sticker collage (a pink brush-script «Cineko»,
// a blue comic bay, a «wanted» poster, a postcard, stickers: @martytv/ui decor/collage); over Home's
// hero a duotone grade, a halftone corner and a diagonal gutter like a panel of a game's box art.
import { StickerDesk } from "@martytv/ui/decor/collage";
import type { WebLook } from "../look";
import "./fivestars.css";

function Scene() {
  return (
    <div className="fs-scene wd-fill">
      <StickerDesk className="fs-collage" preserveAspectRatio="xMaxYMax slice" />
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <div className="fs-grade" />
      <div className="fs-dots" />
      <span className="fs-gutter" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };
