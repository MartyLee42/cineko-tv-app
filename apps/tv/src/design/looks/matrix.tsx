// «Матрица»: columns of falling code. Also the «Матрица» player loader's backdrop (player/loaders/Matrix.tsx).
import "./matrix.css";
import { useCalmMotion } from "../skins";
import type { Look } from "./types";
import { layer, rand } from "./common";

const RAIN_GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789Z:.=*+<>";
export const RAIN_COLUMNS = 64;

/** Columns of falling code, fixed once (deterministic): x, start row, tail glyphs, head glyph, brightness. */
const RAIN = (() => {
  const r = rand(1999);
  const cols: { x: number; top: number; tail: string; head: string; o: number }[] = [];
  for (let i = 0; i < RAIN_COLUMNS; i++) {
    const len = 6 + Math.floor(r() * 18);
    let tail = "";
    for (let k = 0; k < len; k++) tail += RAIN_GLYPHS[Math.floor(r() * RAIN_GLYPHS.length)];
    cols.push({
      x: Math.round(i * 30 + r() * 10),
      top: Math.round(-200 + r() * 900),
      tail,
      head: RAIN_GLYPHS[Math.floor(r() * RAIN_GLYPHS.length)]!,
      o: 0.18 + r() * 0.5,
    });
  }
  return cols;
})();

/**
 * Static digital rain: green glyph columns with a bright head, a dark veil
 * over the lower half and scanlines. Plain text in a few dozen divs — cheap
 * on old TV engines (nothing animates).
 */
export function RainBackground() {
  // «Фон движется»: every 8th column slowly falls (transform only); «Спокойно» keeps all still.
  const calm = useCalmMotion();
  return (
    <div aria-hidden data-skin-bg="rain" data-motion={calm ? "calm" : "on"} className={`mx-rain ${layer}`}>
      {RAIN.map((c, i) => (
        <div
          key={c.x}
          className={`mx-col ${!calm && i % 8 === 3 ? "mx-fall" : ""}`}
          style={{ left: c.x, top: c.top, opacity: c.o, animationDelay: !calm && i % 8 === 3 ? `${-((i * 7) % 20)}s` : undefined }}
        >
          {c.tail}
          <span className="mx-head">{c.head}</span>
        </div>
      ))}
      <div className="mx-veil absolute left-0 top-0 h-full w-full" />
      <div className="cp-scan absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

export const look: Look = { Background: () => <RainBackground /> };
