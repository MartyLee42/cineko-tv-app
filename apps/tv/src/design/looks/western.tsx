// «Вестерн»: a spaghetti-western homage (original drawings only). A sun-bleached desert sky
// over dusty mesas; posters are «Разыскивается» bills (western.css); black letterbox bars over
// Home's hero and Details; the Details title on a wanted bill; OK on a card zooms in like a
// standoff close-up (.ww-standoff, ≈¼ s) before Details opens.
import "./western.css";
import { useEffect, type ReactNode } from "react";
import { useI18n } from "@martytv/ui";
import type { Look } from "./types";
import { layer } from "./common";

/** Mesas and buttes along the horizon (far, then near), as one path each. */
const FAR_RIDGE = "M0 790 L120 784 L170 742 L330 738 L372 786 L560 792 L640 770 L700 706 L880 700 L922 760 L1060 776 L1130 752 L1210 750 L1240 782 L1420 790 L1500 728 L1560 640 L1700 636 L1730 700 L1790 780 L1920 786 L1920 1080 L0 1080 Z";
const NEAR_RIDGE = "M0 870 L210 858 L260 830 L420 826 L460 864 L760 880 L980 872 L1040 846 L1180 842 L1210 870 L1500 884 L1920 866 L1920 1080 L0 1080 Z";
/** A saguaro, drawn from its base at (0,0) upwards. */
const SAGUARO =
  "M-16 0 L-16 -230 C -16 -262 16 -262 16 -230 L16 -120 L46 -120 L46 -176 C 46 -196 70 -196 70 -176 L70 -110 C 70 -96 60 -88 46 -88 L16 -88 L16 0 Z M-16 -100 L-48 -100 C -60 -100 -70 -110 -70 -124 L-70 -160 C -70 -180 -46 -180 -46 -160 L-46 -132 L-16 -132 Z";
/** Two buzzards circling: [x, y, wing span]. */
const BIRDS: [number, number, number][] = [
  [1180, 160, 34],
  [1260, 214, 24],
];

/** The desert at high noon: a pale sun, a heat-white sky, two ridges and a saguaro. Static. */
function Desert({ dim }: { dim: boolean }) {
  const { t } = useI18n();
  // The bills' «РАЗЫСКИВАЕТСЯ» / «НАГРАДА» are CSS content (western.css), in the UI language.
  useEffect(() => {
    const s = document.documentElement.style;
    s.setProperty("--ww-wanted", JSON.stringify(t("western.wanted").toUpperCase()));
    s.setProperty("--ww-reward", JSON.stringify(`${t("western.reward").toUpperCase()} $`));
    return () => {
      s.removeProperty("--ww-wanted");
      s.removeProperty("--ww-reward");
    };
  }, [t]);
  return (
    <div data-skin-bg="desert" className={`ww-sky ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <defs>
          <radialGradient id="ww-sun" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#fffaf0" />
            <stop offset="0.42" stopColor="#fff4dc" />
            <stop offset="0.5" stopColor="#fbe9c4" stopOpacity="0.55" />
            <stop offset="1" stopColor="#f4dfb6" stopOpacity="0" />
          </radialGradient>
        </defs>
        {!dim && <circle cx="1560" cy="250" r="260" fill="url(#ww-sun)" />}
        <g opacity={dim ? 0.35 : 0.8}>
          <path d={FAR_RIDGE} fill="#ddb57e" />
          <path d={NEAR_RIDGE} fill="#d29d5f" />
          <rect x="0" y="960" width="1920" height="120" fill="#c88f52" opacity=".55" />
        </g>
        {!dim && (
          <g fill="#7a4a26" opacity=".55">
            <path d={SAGUARO} transform="translate(1800 900) scale(.9)" />
            <path d={SAGUARO} transform="translate(1690 884) scale(-.45 .45)" />
          </g>
        )}
        {!dim && (
          <g fill="none" stroke="#5a3a22" strokeWidth="4" strokeLinecap="round" opacity=".45">
            {BIRDS.map(([x, y, w]) => (
              <path key={x} d={`M${x - w} ${y} Q ${x - w / 2} ${y - w / 2.4} ${x} ${y} Q ${x + w / 2} ${y - w / 2.4} ${x + w} ${y}`} />
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

/** Over Home's hero: a warm sun cast on the artwork and the letterbox bars (top, and the screen's bottom). */
function WesternHeroEdges() {
  return (
    <>
      <div className="ww-sunwash pointer-events-none absolute left-0 top-0 h-full w-full" />
      <span className="ww-bar ww-bar-top" style={{ left: -600 }} />
      <span className="ww-bar ww-bar-bottom" style={{ left: -600, top: 1032 }} />
    </>
  );
}

/** Details: the title on a wanted bill nailed up: «РАЗЫСКИВАЕТСЯ · ФИЛЬМ», the name, «живым или мёртвым». */
function WantedPlate({ children, kind }: { children: ReactNode; kind: string }) {
  const { t } = useI18n();
  return (
    <div data-testid="wanted-plate" className="ww-bill relative mt-3 px-[40px] pb-[20px] pt-[24px]">
      <span className="ww-nail" style={{ left: 16, top: 14 }} />
      <span className="ww-nail" style={{ right: 16, top: 14 }} />
      <p className="ww-bill-head">
        {t("western.wanted")} · {kind}
      </p>
      {children}
      <p className="ww-bill-foot">— {t("western.dead_or_alive")} —</p>
    </div>
  );
}

/** OK on a card: a quick push-in on the bill, a standoff close-up (≤ ¼ s), then Details opens. */
const standoff = {
  ms: 230,
  start(card: HTMLElement) {
    card.classList.add("ww-standoff");
    // Details covers the row by then; a card kept mounted under it comes back unzoomed.
    setTimeout(() => card.classList.remove("ww-standoff"), 700);
  },
};

export const look: Look = { Background: ({ dim }) => <Desert dim={dim} />, HeroEdges: WesternHeroEdges, TitlePlate: WantedPlate, pick: standoff };
