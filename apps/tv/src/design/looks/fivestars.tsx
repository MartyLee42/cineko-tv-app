// «Пять звёзд»: an homage to open-world crime games (original drawings only). A city at sunset: a
// low sun behind the towers, palms, searchlights, a blimp with Cineko's name and a freeway whose
// traffic is the one animated layer (stopped when calm). Cards are collage panels from a box cover
// (fivestars.css); Details' title is a mission card with five wanted stars; OK on a card is a camera
// switch (a quick push-in with a white flash); a row ends on «Миссия выполнена». The status corner
// is a game HUD whose wanted stars light up while the server is in trouble (fivestars.css).
import "./fivestars.css";
import type { ReactNode } from "react";
import { useI18n } from "@martytv/ui";
import { palm, starField, starPath, towers } from "@martytv/ui/decor";
import type { Look } from "./types";
import { layer } from "./common";

const FAR = towers(7, -20, 1940, 905, 150, 430, 6);
const NEAR = towers(19, -30, 1950, 1080, 110, 300, 8);
const WINDOW = ["#ffd38a", "#ff7ab6", "#8ff3ff"];
const STARS = starField(46, 11, 1920, 360);
const PALMS = [palm(78, 1080, 600, 46), palm(236, 1080, 430, -34), palm(1856, 1080, 640, -58)];
/** Lamp posts and pillars of the elevated freeway (every 160 px). */
const PILLARS = Array.from({ length: 13 }, (_, i) => i * 160 + 40);
/** Light streaks on the deck: [x, length] (the strip is drawn twice, 1920 apart, and slides). */
const LIGHTS: [number, number][] = [
  [60, 34],
  [210, 22],
  [330, 40],
  [520, 26],
  [700, 30],
  [860, 22],
  [1010, 38],
  [1190, 24],
  [1330, 32],
  [1500, 22],
  [1660, 36],
  [1810, 26],
];
const STAR = starPath(20);

/** The freeway's two lanes of light: headlights drive right, tail-lights left (transform only). */
function Traffic({ calm }: { calm: boolean }) {
  const strip = (y: number, fill: string) =>
    [0, 1920].map((off) => (
      <g key={off} transform={`translate(${off} 0)`}>
        {LIGHTS.map(([x, w]) => (
          <rect key={x} x={x} y={y} width={w} height="3" rx="1.5" fill={fill} />
        ))}
      </g>
    ));
  return (
    <>
      <g className={calm ? undefined : "fs-drive-r"}>{strip(941, "#fff2d6")}</g>
      <g className={calm ? undefined : "fs-drive-l"} transform="translate(-1920 0)">
        {strip(950, "#ff4a5a")}
      </g>
    </>
  );
}

/** Sunset over the city. `dim` (Settings, guide): no sun, blimp or searchlights; the city darker. */
function City({ calm, dim }: { calm: boolean; dim: boolean }) {
  return (
    <div data-skin-bg="sunset" className={`fs-sky ${dim ? "fs-sky-dim" : ""} ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <defs>
          <radialGradient id="fs-sun" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#fff1b0" />
            <stop offset="0.5" stopColor="#ffb85a" />
            <stop offset="1" stopColor="#ff4f86" />
          </radialGradient>
          <linearGradient id="fs-beam" x1="0" x2="0" y1="1" y2="0">
            <stop offset="0" stopColor="#fff5ec" stopOpacity=".16" />
            <stop offset="1" stopColor="#fff5ec" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g fill="#fff5ec">
          {STARS.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r * 0.8} opacity={dim ? 0.18 : s.o * 0.55} />
          ))}
        </g>
        {!dim && (
          <>
            <circle cx="1380" cy="770" r="236" fill="url(#fs-sun)" />
            <path d="M640 905 L470 0 L610 0 Z" fill="url(#fs-beam)" />
            <path d="M1060 905 L1150 0 L1290 0 Z" fill="url(#fs-beam)" />
            {/* The blimp: Cineko's name in lights on its side. */}
            <g transform="translate(1560 430) rotate(-4)">
              <path d="M150 0 L196 -34 L204 -34 L190 0 L204 34 L196 34 Z" fill="#2c1440" />
              <ellipse cx="0" cy="0" rx="172" ry="50" fill="#3a1a54" />
              <ellipse cx="-20" cy="-18" rx="130" ry="16" fill="#ff8fc0" opacity=".16" />
              <rect x="-34" y="46" width="68" height="16" rx="5" fill="#2c1440" />
              <text x="-8" y="16" textAnchor="middle" className="fs-blimp-text">
                Cineko
              </text>
            </g>
          </>
        )}
        <g opacity={dim ? 0.55 : 1}>
          {FAR.map((b) => (
            <g key={b.x}>
              <rect x={b.x} y={905 - b.h} width={b.w} height={b.h} fill="#3b1752" />
              {b.antenna && <rect x={b.x + b.w / 2 - 2} y={905 - b.h - 46} width="4" height="46" fill="#3b1752" />}
              {b.antenna && <circle cx={b.x + b.w / 2} cy={905 - b.h - 48} r="4" fill="#ff4a5a" />}
              {b.win.map((w, i) => (
                <rect key={i} x={w.x} y={w.y} width="6" height="9" fill={WINDOW[w.c]} opacity=".45" />
              ))}
            </g>
          ))}
          {/* The elevated freeway: deck, pillars, a pink rim of sunset on its edge. */}
          <rect x="0" y="934" width="1920" height="26" fill="#12081d" />
          <rect x="0" y="934" width="1920" height="3" fill="#ff6a8f" opacity=".7" />
          {PILLARS.map((x) => (
            <rect key={x} x={x} y="960" width="22" height="120" fill="#12081d" />
          ))}
          <Traffic calm={calm || dim} />
          {NEAR.map((b) => (
            <g key={b.x}>
              <rect x={b.x} y={1080 - b.h} width={b.w} height={b.h} fill="#1a0b28" />
              {b.win.map((w, i) => (
                <rect key={i} x={w.x} y={w.y} width="6" height="9" fill={WINDOW[w.c]} opacity=".7" />
              ))}
            </g>
          ))}
          <g fill="#0b0612">
            {PALMS.map((p, i) => (
              <g key={i}>
                <path d={p.trunk} />
                {p.fronds.map((f, j) => (
                  <path key={j} d={f} />
                ))}
              </g>
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}

/** Over Home's backdrop: a sunset grade, a halftone corner and a diagonal gutter, like a panel of the box art. */
function HeroGrade() {
  return (
    <>
      <div className="fs-grade pointer-events-none absolute left-0 top-0 h-full w-full" />
      <div className="fs-dots pointer-events-none absolute bottom-0 right-0" />
      <svg className="pointer-events-none absolute left-0 top-0" width="1320" height="690" viewBox="0 0 1320 690" aria-hidden>
        <path d="M1150 0 L1196 0 L1060 690 L1014 690 Z" fill="#0b0612" />
        <path d="M1150 0 L1157 0 L1021 690 L1014 690 Z M1189 0 L1196 0 L1060 690 L1053 690 Z" fill="#fff5ec" />
      </svg>
    </>
  );
}

/** Five wanted stars (static; the mission card flashes them red and blue once). */
function Stars({ className }: { className?: string }) {
  return (
    <svg className={className} width="210" height="40" viewBox="-20 -20 210 40" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={i} d={STAR} transform={`translate(${i * 42} 0)`} />
      ))}
    </svg>
  );
}

/** Details: the title as a mission card: «Миссия · Фильм» in script, the title, the wanted stars. */
function MissionPlate({ children, kind }: { children: ReactNode; kind: string }) {
  const { t } = useI18n();
  return (
    <div data-testid="mission-plate" className="fs-mission relative mt-2">
      <p className="fs-mission-label">
        {t("fivestars.mission")} · {kind}
      </p>
      {children}
      <div className="fs-mission-wanted">
        <Stars className="fs-stars" />
        <span className="fs-mission-caption">{t("fivestars.wanted")}</span>
      </div>
    </div>
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

export const look: Look = { Background: City, HeroEdges: HeroGrade, TitlePlate: MissionPlate, pick: cameraSwitch, End: MissionPassed };
