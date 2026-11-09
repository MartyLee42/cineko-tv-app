// «Вестерн»: the desert at high noon — a sun-bleached sky with a pale sun, two buzzards circling
// slowly, dusty mesas and buttes on the horizon, saguaros; over Home's hero a warm sun-wash and
// black letterbox bars (a widescreen standoff).
import type { WebLook } from "../look";
import "./western.css";

const FAR_RIDGE = "M0 790 L120 784 L170 742 L330 738 L372 786 L560 792 L640 770 L700 706 L880 700 L922 760 L1060 776 L1130 752 L1210 750 L1240 782 L1420 790 L1500 728 L1560 640 L1700 636 L1730 700 L1790 780 L1920 786 L1920 1080 L0 1080 Z";
const NEAR_RIDGE = "M0 870 L210 858 L260 830 L420 826 L460 864 L760 880 L980 872 L1040 846 L1180 842 L1210 870 L1500 884 L1920 866 L1920 1080 L0 1080 Z";
const SAGUARO =
  "M-16 0 L-16 -230 C -16 -262 16 -262 16 -230 L16 -120 L46 -120 L46 -176 C 46 -196 70 -196 70 -176 L70 -110 C 70 -96 60 -88 46 -88 L16 -88 L16 0 Z M-16 -100 L-48 -100 C -60 -100 -70 -110 -70 -124 L-70 -160 C -70 -180 -46 -180 -46 -160 L-46 -132 L-16 -132 Z";

function Scene() {
  return (
    <div className="ww-scene wd-fill">
      <div className="ww-sun" />
      <svg className="ww-birds" viewBox="-60 -40 120 80">
        <g className="ww-bird-a">
          <path d="M-34 0 Q -17 -14 0 0 Q 17 -14 34 0" />
        </g>
        <g className="ww-bird-b">
          <path d="M-24 0 Q -12 -10 0 0 Q 12 -10 24 0" />
        </g>
      </svg>
      <svg className="ww-land" viewBox="0 600 1920 480" preserveAspectRatio="xMidYMax slice">
        <path d={FAR_RIDGE} fill="#ddb57e" opacity=".85" />
        <path d={NEAR_RIDGE} fill="#d29d5f" opacity=".85" />
        <rect x="0" y="960" width="1920" height="120" fill="#c88f52" opacity=".5" />
        <g fill="#7a4a26" opacity=".55">
          <path d={SAGUARO} transform="translate(1800 900) scale(.9)" />
          <path d={SAGUARO} transform="translate(1690 884) scale(-.45 .45)" />
          <path d={SAGUARO} transform="translate(1110 896) scale(.6)" />
          <path d={SAGUARO} transform="translate(160 892) scale(-.55 .55)" />
        </g>
      </svg>
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <div className="ww-sunwash" />
      <span className="ww-bar ww-bar-top" />
      <span className="ww-bar ww-bar-bottom" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };
