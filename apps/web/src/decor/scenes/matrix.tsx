// «Матрица»: columns of falling code like the TV's — green glyph columns with a bright head;
// every 6th column slowly falls (transform only), the rest stand still; a dark veil over the
// lower part and scanlines keep the page readable.
import { rand } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./matrix.css";

const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789Z:.=*+<>";
const COLUMNS = 96;

const RAIN = (() => {
  const r = rand(1999);
  const pick = () => GLYPHS[Math.floor(r() * GLYPHS.length)]!;
  return Array.from({ length: COLUMNS }, (_, i) => {
    const len = 6 + Math.floor(r() * 18);
    let tail = "";
    for (let k = 0; k < len; k++) tail += pick();
    return { x: Math.round(i * 24 + r() * 6), top: Math.round(-160 + r() * 700), tail, head: pick(), o: +(0.18 + r() * 0.5).toFixed(2), fall: i % 6 === 3, delay: -((i * 7) % 24) };
  });
})();

function Scene() {
  return (
    <div className="mx-scene wd-fill">
      {RAIN.map((c) => (
        <div key={c.x} className={`mx-col ${c.fall ? "mx-fall" : ""}`} style={{ left: c.x, top: c.top, opacity: c.o, animationDelay: c.fall ? `${c.delay}s` : undefined }}>
          {c.tail}
          <span className="mx-head">{c.head}</span>
        </div>
      ))}
      <div className="mx-veil wd-fill" />
      <div className="mx-scan wd-fill" />
    </div>
  );
}

export const look: WebLook = { Scene };
