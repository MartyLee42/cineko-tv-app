// «Вверх»: colourful balloons get tied to a little house, one per ~7 %;
// at 100 % it floats off. Original drawing: a small cottage and a bunch.
import { ArtBox, At, type ArtProps } from "./parts";
import { balloonsAt, balloonSpot, BALLOONS_TOTAL } from "./logic";

const CSS = `
.ld-float { animation: ld-float 1.8s cubic-bezier(.45,0,.7,.4) both; }
@keyframes ld-float { from { transform: translate3d(0,0,0) rotate(0deg); } 40% { transform: translate3d(10px,-90px,0) rotate(2deg); } to { transform: translate3d(-20px,-760px,0) rotate(-3deg); } }
.ld-sway { animation: ld-sway 3.4s ease-in-out infinite alternate; transform-origin: 50% 100%; }
@keyframes ld-sway { from { transform: rotate(-2.5deg); } to { transform: rotate(2.5deg); } }
`;

const COLORS = ["#ff5a5f", "#ffb400", "#2ec4b6", "#7b61ff", "#ff7ac6", "#3fa9f5", "#8bd346", "#ff8c42"];
// The knot (chimney top) in art px; the bunch floats this far above it.
const KX = 655;
const KY = 300;
const LIFT = 130;

export function BalloonsArt({ p, width, calm, done, label }: ArtProps & { label?: string }) {
  const n = done ? BALLOONS_TOTAL : balloonsAt(p);
  const spots = Array.from({ length: n }, (_, i) => balloonSpot(i));
  return (
    <ArtBox width={width} calm={calm} css={CSS} label={label}>
      {/* ground */}
      <At x={140} y={512} w={920} h={30} style={{ borderRadius: "50%", background: "rgba(120,200,110,.28)" }} />
      <div className={done ? "ld-float" : undefined} style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 560 }}>
        <div className={calm || done ? undefined : "ld-sway"} style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 560 }}>
          {/* strings */}
          <svg width="1200" height="560" viewBox="0 0 1200 560" style={{ position: "absolute", left: 0, top: 0 }} aria-hidden>
            {spots.map((s, i) => (
              <path key={i} d={`M${KX} ${KY} Q${KX + s.x * 0.3} ${KY - LIFT * 0.5} ${KX + s.x} ${KY - LIFT + s.y + 34}`} stroke="rgba(255,255,255,.55)" strokeWidth="2" fill="none" />
            ))}
          </svg>
          {/* balloons */}
          {spots.map((s, i) => (
            <At key={i} x={KX + s.x - 30} y={KY - LIFT + s.y - 40} w={60} h={80}>
              <div className={calm ? undefined : "ld-pop"}>
                <svg width="60" height="80" viewBox="0 0 60 80" aria-hidden>
                  <ellipse cx="30" cy="34" rx="27" ry="32" fill={COLORS[i % COLORS.length]} />
                  <path d="M26 66 L34 66 L30 72 Z" fill={COLORS[i % COLORS.length]} />
                  <ellipse cx="20" cy="22" rx="7" ry="10" fill="#fff" opacity=".35" />
                </svg>
              </div>
            </At>
          ))}
          {/* the house */}
          <At x={470} y={290} w={300} h={240}>
            <svg width="300" height="240" viewBox="0 0 300 240" aria-hidden>
              {/* chimney */}
              <rect x="170" y="8" width="30" height="50" fill="#8a5a44" />
              {/* roof */}
              <path d="M20 100 L150 22 L280 100 Z" fill="#5b6bbf" stroke="#3f4c95" strokeWidth="6" strokeLinejoin="round" />
              {/* walls */}
              <rect x="44" y="98" width="212" height="128" fill="#f2c97d" />
              <path d="M44 120 H256 M44 144 H256 M44 168 H256 M44 192 H256" stroke="#d9ac5d" strokeWidth="3" />
              {/* porch + door */}
              <rect x="122" y="150" width="56" height="76" rx="6" fill="#7a4e3a" />
              <circle cx="166" cy="190" r="4" fill="#ffd34d" />
              <rect x="108" y="222" width="84" height="10" fill="#c98f62" />
              {/* windows */}
              <rect x="64" y="128" width="40" height="40" rx="4" fill="#ffe7a0" stroke="#fff" strokeWidth="4" />
              <rect x="196" y="128" width="40" height="40" rx="4" fill="#ffe7a0" stroke="#fff" strokeWidth="4" />
              <circle cx="150" cy="70" r="14" fill="#ffe7a0" stroke="#fff" strokeWidth="4" />
            </svg>
          </At>
        </div>
      </div>
    </ArtBox>
  );
}
