// «Назад в будущее»: a speedometer whose needle and digital readout climb
// with progress, 0 → 88 mph. At 88 (the film starts) two fire trails shoot
// off and the screen flashes. Original drawing: a generic dial and LED
// digits, no film lettering or logos.
import { ArtBox, At, type ArtProps } from "./parts";
import { DIAL_MAX, mphAt, needleAngle } from "./logic";

const CSS = `
.ld-trail { transform-origin: 0 50%; animation: ld-trail .8s cubic-bezier(.2,.7,.3,1) both; }
@keyframes ld-trail { from { transform: scaleX(0); opacity: 1; } 70% { opacity: 1; } to { transform: scaleX(1); opacity: .85; } }
.ld-flash { animation: ld-flash .7s ease-out both; }
@keyframes ld-flash { from { opacity: .9; } to { opacity: 0; } }
.ld-shake { animation: ld-shake .12s linear infinite; }
@keyframes ld-shake { 0%,100% { transform: translate3d(0,0,0); } 50% { transform: translate3d(2px,-1px,0); } }
.ld-needle { transition: transform .6s cubic-bezier(.25,.6,.4,1); transform-origin: 50% 100%; }
`;

const CX = 600;
const CY = 290;
const R = 250;

function polar(deg: number, r: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [250 + r * Math.cos(a), 250 + r * Math.sin(a)];
}

function arc(from: number, to: number, r: number): string {
  const [x1, y1] = polar(from, r);
  const [x2, y2] = polar(to, r);
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/** The static dial (ticks every 10 mph, red zone from 80). */
function Dial() {
  const ticks = [];
  for (let m = 0; m <= DIAL_MAX; m += 5) {
    const a = needleAngle(m);
    const major = m % 10 === 0;
    const [x1, y1] = polar(a, 226);
    const [x2, y2] = polar(a, major ? 196 : 210);
    ticks.push(<line key={m} x1={x1} y1={y1} x2={x2} y2={y2} stroke={m >= 80 ? "#ff5a3c" : "rgba(255,255,255,.8)"} strokeWidth={major ? 6 : 3} strokeLinecap="round" />);
    if (major) {
      const [tx, ty] = polar(a, 166);
      ticks.push(
        <text key={`t${m}`} x={tx} y={ty + 10} textAnchor="middle" fontSize="28" fontWeight="700" fill={m >= 80 ? "#ff7a5c" : "rgba(255,255,255,.75)"} fontFamily="'JetBrains Mono', ui-monospace, monospace">
          {m}
        </text>,
      );
    }
  }
  const [mx, my] = polar(needleAngle(88), 236);
  return (
    <svg width="500" height="500" viewBox="0 0 500 500" aria-hidden>
      <circle cx="250" cy="250" r="244" fill="#121218" stroke="#3b3b48" strokeWidth="8" />
      <circle cx="250" cy="250" r="232" fill="none" stroke="#24242e" strokeWidth="4" />
      <path d={arc(needleAngle(0), needleAngle(80), 226)} stroke="rgba(255,255,255,.18)" strokeWidth="4" fill="none" />
      <path d={arc(needleAngle(80), needleAngle(DIAL_MAX), 218)} stroke="#ff5a3c" strokeWidth="18" fill="none" opacity=".55" />
      {ticks}
      <circle cx={mx} cy={my} r="9" fill="#ffd34d" />
    </svg>
  );
}

export function SpeedoArt({ p, width, calm, done, label }: ArtProps & { label?: string }) {
  const mph = done ? 88 : mphAt(p);
  const angle = needleAngle(mph);
  const hot = mph >= 80;
  const digits = String(mph).padStart(2, "0");
  return (
    <ArtBox width={width} calm={calm} css={CSS} label={label}>
      <At x={CX - R} y={CY - R} w={2 * R} h={2 * R} className={hot && !done ? "ld-shake" : undefined}>
        <Dial />
        {/* needle */}
        <At x={R - 7} y={R - 210} w={14} h={210} className="ld-needle" style={{ transform: `rotate(${angle}deg)` }}>
          <div style={{ width: 14, height: 210, borderRadius: 7, background: "linear-gradient(180deg, #ff5a3c, #ffb03c)", boxShadow: "0 0 18px rgba(255,90,60,.7)" }} />
        </At>
        <At x={R - 26} y={R - 26} w={52} h={52} style={{ borderRadius: 26, background: "#2b2b36", border: "6px solid #ff5a3c" }} />
        {/* LED readout */}
        <At x={R - 110} y={R + 64} w={220} h={92} style={{ background: "#0a0a0e", borderRadius: 14, border: "3px solid #3b3b48", textAlign: "center" }}>
          <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 62, fontWeight: 800, lineHeight: "84px", color: hot ? "#ff6a3c" : "#ffb03c", textShadow: `0 0 14px ${hot ? "rgba(255,90,60,.8)" : "rgba(255,176,60,.6)"}` }}>
            {digits}
          </span>
          <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 22, fontWeight: 700, marginLeft: 8, color: "rgba(255,255,255,.6)" }}>MPH</span>
        </At>
      </At>
      {done && (
        <>
          {/* two fire trails shoot off to the right, in front of the dial */}
          {[500, 540].map((y, i) => (
            <At key={y} x={CX - 340} y={y} w={1100} h={26} className="ld-trail" style={{ animationDelay: `${i * 0.06}s`, background: "linear-gradient(90deg, #fff6c4, #ffd34d 12%, #ff7a1a 40%, rgba(255,60,20,.6) 70%, rgba(255,60,20,0))", borderRadius: 13 }} />
          ))}
          {[500, 540].map((y) => (
            <At key={`g${y}`} x={CX - 340} y={y - 22} w={1100} h={70} className="ld-trail" style={{ background: "linear-gradient(90deg, rgba(255,180,60,.5), rgba(255,90,30,0) 70%)", borderRadius: 35, opacity: 0.6 }} />
          ))}
        </>
      )}
      {done && <At x={0} y={0} w={1200} h={560} className="ld-flash" style={{ background: "radial-gradient(circle at 50% 60%, rgba(255,255,255,.9), rgba(120,190,255,.4) 40%, rgba(120,190,255,0) 70%)" }} />}
    </ArtBox>
  );
}
