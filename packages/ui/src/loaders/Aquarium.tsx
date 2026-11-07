// «Аквариум»: torrent pieces fall into Cineko's bowl as little fish (one per
// 1/FISH_TOTAL, at most FISH_FALLING falling at a time); his eyes follow the
// newest one, the water rises. Full → he licks his lips and the bowl turns
// into ▶.
import { ArtBox, At, CinekoFace, type ArtProps } from "./parts";
import { fishAt, FISH_FALLING, lookAt } from "./logic";

const CSS = `
.ld-fall { animation: ld-fall .9s cubic-bezier(.5,0,.75,.4) both; }
@keyframes ld-fall { from { transform: translate3d(0,-420px,0) rotate(80deg); opacity: .2; } 70% { opacity: 1; } to { transform: translate3d(0,0,0) rotate(0deg); opacity: 1; } }
.ld-swim { animation: ld-swim 3.2s ease-in-out infinite alternate; }
@keyframes ld-swim { from { transform: translate3d(-16px,0,0); } to { transform: translate3d(16px,-6px,0); } }
.ld-play { transition: opacity .5s ease, transform .5s cubic-bezier(.3,1.5,.5,1); }
`;

// The bowl (art px): a circle centred at (BX, BY) of radius R.
const BX = 470;
const BY = 300;
const R = 230;

function FishSvg({ hue, right }: { hue: number; right: boolean }) {
  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden style={{ transform: right ? undefined : "scaleX(-1)" }}>
      <path d="M8 20 L0 8 L0 32 Z" fill={`hsl(${hue},85%,55%)`} />
      <ellipse cx="32" cy="20" rx="24" ry="14" fill={`hsl(${hue},90%,62%)`} />
      <path d="M26 7 Q34 0 40 8" fill={`hsl(${hue},85%,52%)`} />
      <circle cx="46" cy="16" r="4.5" fill="#fff" />
      <circle cx="47.5" cy="16" r="2.2" fill="#14121c" />
    </svg>
  );
}

export function AquariumArt({ p, width, calm, done, label }: ArtProps & { label?: string }) {
  const fish = fishAt(p);
  const n = fish.length;
  const latest = n ? fish[n - 1]! : null;
  // Fish positions in art px.
  const fx = (f: { x: number }) => BX - R + f.x * 2 * R;
  const fy = (f: { y: number }) => BY - R * 0.35 + f.y * R * 1.05;
  const look = latest ? lookAt(930, 230, fx(latest), fy(latest)) : { dx: -0.6, dy: 0.3 };
  const water = 0.25 + 0.7 * Math.min(1, p);
  return (
    <ArtBox width={width} calm={calm} css={CSS} label={label}>
      {/* table */}
      <At x={150} y={526} w={940} h={10} style={{ background: "rgba(var(--mt-text), .14)", borderRadius: 5 }} />
      {/* water: a disc clipped by a box whose top drops as it fills */}
      <At x={BX - R} y={BY - R} w={2 * R} h={2 * R} style={{ borderRadius: R, overflow: "hidden", opacity: done ? 0 : 1, transition: "opacity .5s" }}>
        <div
          className="ld-ease"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 2 * R,
            height: 2 * R,
            transformOrigin: "50% 100%",
            transform: `scaleY(${water})`,
            background: "linear-gradient(180deg, rgba(90,190,255,.42), rgba(40,110,210,.55))",
          }}
        />
        {/* gravel */}
        <div style={{ position: "absolute", left: 0, top: 2 * R - 70, width: 2 * R, height: 70, background: "repeating-linear-gradient(90deg,#c9a46b 0 14px,#a9824d 14px 26px,#e2c08a 26px 36px)", opacity: 0.9 }} />
      </At>
      {/* fish (behind the glass highlight) */}
      {!done &&
        fish.map((f, i) => (
          <At key={f.i} x={fx(f) - 32} y={fy(f) - 20} w={64} h={40}>
            <div className={i >= n - FISH_FALLING && !calm ? "ld-fall" : undefined}>
              <div className={calm ? undefined : "ld-swim"} style={{ animationDelay: `${-(f.i % 5) * 0.7}s`, animationDuration: `${2.6 + (f.i % 4) * 0.5}s` }}>
                <FishSvg hue={f.hue} right={f.right} />
              </div>
            </div>
          </At>
        ))}
      {/* the glass bowl */}
      <At x={BX - R - 8} y={BY - R - 8} w={2 * R + 16} h={2 * R + 16}>
        <svg width={2 * R + 16} height={2 * R + 16} viewBox="0 0 476 476" aria-hidden style={{ opacity: done ? 0.25 : 1, transition: "opacity .5s" }}>
          <path d="M140 24 L336 24" stroke="rgba(200,235,255,.75)" strokeWidth="10" strokeLinecap="round" />
          <path d="M149 26 A230 230 0 1 0 327 26" fill="none" stroke="rgba(200,235,255,.6)" strokeWidth="7" />
          <path d="M78 150 A190 190 0 0 0 70 300" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="9" strokeLinecap="round" />
        </svg>
      </At>
      {/* full: the bowl becomes ▶ */}
      <At x={BX - 130} y={BY - 150} w={300} h={300} className="ld-play" style={{ opacity: done ? 1 : 0, transform: done ? "scale(1)" : "scale(.4)" }}>
        <svg width="300" height="300" viewBox="0 0 300 300" aria-hidden>
          <path d="M70 40 L260 150 L70 260 Z" fill="rgb(var(--mt-accent))" stroke="rgba(255,255,255,.85)" strokeWidth="10" strokeLinejoin="round" />
        </svg>
      </At>
      {/* Cineko watches from the right */}
      <At x={820} y={110} w={260} h={260} className={done || calm ? undefined : "ld-bob"}>
        <CinekoFace size={260} look={look} mood={done ? "lick" : "watch"} />
      </At>
      {/* paws on the table edge */}
      <At x={850} y={478} w={200} h={50}>
        <svg width="200" height="50" viewBox="0 0 200 50" aria-hidden>
          <ellipse cx="50" cy="30" rx="34" ry="18" fill="#1d1a29" stroke="#ff5fa2" strokeOpacity=".5" strokeWidth="3" />
          <ellipse cx="150" cy="30" rx="34" ry="18" fill="#1d1a29" stroke="#ff5fa2" strokeOpacity=".5" strokeWidth="3" />
        </svg>
      </At>
    </ArtBox>
  );
}
