// «Следы лапок»: paw prints walk across the ground, one per 5 %; Cineko
// walks above the newest one. Progress stalls for a while → the last paw
// taps impatiently (and he looks worried); at 100 % he hops.
import { ArtBox, At, CinekoFace, useStalled, type ArtProps } from "./parts";
import { PAW_STEPS, pawSteps } from "./logic";

const CSS = `
.ld-paw-tap { animation: ld-paw-tap .55s ease-in-out infinite; }
@keyframes ld-paw-tap { 0%,100% { transform: translate3d(0,0,0) rotate(0deg); } 40% { transform: translate3d(0,-16px,0) rotate(-14deg); } }
.ld-hop { animation: ld-hop .7s ease-in-out infinite; }
@keyframes ld-hop { 0%,100% { transform: translate3d(0,0,0); } 45% { transform: translate3d(0,-36px,0); } }
`;

const X0 = 70;
const STEP = (1200 - 2 * X0) / (PAW_STEPS - 1);
const pawX = (i: number) => X0 + i * STEP;
/** Left / right feet alternate along a gentle wave. */
const pawY = (i: number) => 470 + (i % 2 ? 26 : -18) + Math.sin(i / 3) * 10;

export function Paw({ size = 48, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <g fill={color}>
        <ellipse cx="24" cy="31" rx="11" ry="9.5" />
        <ellipse cx="10" cy="19" rx="4.6" ry="6" />
        <ellipse cx="19" cy="11" rx="4.6" ry="6.2" />
        <ellipse cx="29" cy="11" rx="4.6" ry="6.2" />
        <ellipse cx="38" cy="19" rx="4.6" ry="6" />
      </g>
    </svg>
  );
}

export function PawsArt({ p, width, calm, done, label }: ArtProps & { label?: string }) {
  const n = pawSteps(p);
  const stalled = useStalled(p) && !done;
  const lead = Math.max(0, n - 1);
  const face = done ? "happy" : stalled ? "worried" : "watch";
  return (
    <ArtBox width={width} calm={calm} css={CSS} label={label}>
      {/* ground */}
      <At x={20} y={530} w={1160} h={4} style={{ background: "rgba(var(--mt-text), .12)", borderRadius: 2 }} />
      {Array.from({ length: PAW_STEPS }, (_, i) => {
        const on = i < n;
        const tap = on && i === n - 1 && stalled;
        return (
          <At key={i} x={pawX(i) - 24} y={pawY(i) - 24} w={48} h={48} style={{ transform: `rotate(${90 + (i % 2 ? 8 : -8)}deg)` }}>
            {on ? (
              <div className={tap ? "ld-paw-tap" : calm ? undefined : "ld-pop"} style={{ color: "rgb(var(--mt-accent))" }}>
                <Paw />
              </div>
            ) : (
              <div style={{ color: "rgba(var(--mt-text), .07)" }}>
                <Paw />
              </div>
            )}
          </At>
        );
      })}
      {/* Cineko walks above the newest print */}
      <At x={0} y={0} w={1200} h={420} className="ld-ease" style={{ transform: `translate3d(${pawX(lead) - 120}px,0,0)` }}>
        <At x={0} y={200} w={240} h={240} className={done ? "ld-hop" : "ld-bob"}>
          <CinekoFace size={240} mood={face} look={{ dx: stalled ? 0 : 0.7, dy: stalled ? 1 : 0.4 }} />
        </At>
      </At>
    </ArtBox>
  );
}
