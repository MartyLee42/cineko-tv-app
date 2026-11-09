// Ticket stubs and achievement stickers, shared by the TV («Моё») and the
// PWA («Билеты»). Sizes are in em: the caller sets font-size on a parent.
// Old TV engines: no gap / aspect-ratio / inset; transforms only.
import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { paperFor, progressLabel, progressShare, punchHoles, stickerKeys, stickerTilt, ticketDate, ticketSerial, tiltFor, type StickerId } from "./logic";
import { GLYPHS } from "./glyphs";
import { metalFor, PALETTES, SHAPES, SPECS, type StickerSpec } from "./stickers";
import "./keepsakes.css";

export * from "./logic";

/** What a stub shows (TicketStub from the API, minus what the card doesn't need). */
export interface StubView {
  number: number;
  date: string;
  time: string;
  hall: number;
  row: number;
  seat: number;
  rating: number | null;
  media: { title: string; year?: number | null };
}

/** A paper cinema ticket: poster, title, date, row/seat, the rating punched into the stub. */
export function TicketCard({
  ticket,
  poster,
  cinema = "Cineko",
  focused = false,
  tilt = true,
  className = "",
}: {
  ticket: StubView;
  poster: string | null;
  cinema?: string;
  focused?: boolean;
  /** Pinned a little crooked (the wall); straight when focused. */
  tilt?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const holes = punchHoles(ticket.rating);
  const angle = tilt && !focused ? tiltFor(ticket.number) : 0;
  const rated = ticket.rating != null ? t("keepsakes.rated", { n: ticket.rating }) : t("keepsakes.unrated");
  return (
    <div
      data-testid="ticket"
      data-number={ticket.number}
      className={`ks-ticket ks-paper-${paperFor(ticket.number)} ${focused ? "ks-focused" : ""} ${className}`}
      style={angle ? { transform: `rotate(${angle}deg)` } : undefined}
      title={t("keepsakes.cinema", { name: cinema })}
    >
      <div className="ks-main">
        <div className="ks-poster">
          {poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : <span className="ks-poster-blank" aria-hidden />}
        </div>
        <div className="ks-body">
          <div className="ks-cinema">
            {cinema} · {t("keepsakes.hall", { n: ticket.hall })}
          </div>
          <div className="ks-title">{ticket.media.title}</div>
          <div className="ks-when">
            {ticketDate(ticket.date)} · {ticket.time}
          </div>
          <div className="ks-seat">{t("keepsakes.seat", { row: ticket.row, seat: ticket.seat })}</div>
        </div>
        <Stamp name={cinema} />
      </div>
      <div className="ks-perf" aria-hidden />
      <div className="ks-stub" title={rated}>
        <div className="ks-no">{t("keepsakes.number", { n: ticketSerial(ticket.number) })}</div>
        <div className="ks-holes" role="img" aria-label={rated}>
          {holes.map((on, i) => (
            <span key={i} className={on ? "ks-hole ks-hole-on" : "ks-hole"} />
          ))}
        </div>
        <div className="ks-label">{ticket.rating != null ? `${t("keepsakes.rating")} ${ticket.rating}` : t("keepsakes.unrated")}</div>
      </div>
    </div>
  );
}

/** The faint rubber stamp: the cinema's name around a robot-cat head. */
function Stamp({ name }: { name: string }) {
  const word = `${name.toUpperCase()} · ${name.toUpperCase()} · `;
  return (
    <svg className="ks-stamp" viewBox="0 0 100 100" aria-hidden>
      <defs>
        <path id="ks-stamp-ring" d="M50 50 m-36 0 a36 36 0 1 1 72 0 a36 36 0 1 1 -72 0" />
      </defs>
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="50" cy="50" r="27" fill="none" stroke="currentColor" strokeWidth="2" />
      <text fontSize="12" fontWeight="700" letterSpacing="2" fill="currentColor">
        <textPath href="#ks-stamp-ring" xlinkHref="#ks-stamp-ring">
          {word}
        </textPath>
      </text>
      {/* Cineko: a robot-cat head with an antenna. */}
      <path d="M36 62 V44 L40 34 L46 41 H54 L60 34 L64 44 V62 Q50 70 36 62 Z" fill="currentColor" />
      <line x1="50" y1="41" x2="50" y2="33" stroke="currentColor" strokeWidth="2" />
      <circle cx="50" cy="31" r="2.5" fill="currentColor" />
      <rect x="41" y="49" width="6" height="5" rx="1.5" fill="#fff" opacity="0.9" />
      <rect x="53" y="49" width="6" height="5" rx="1.5" fill="#fff" opacity="0.9" />
    </svg>
  );
}

// ---------------------------------------------------------------- stickers

/** A die-cut sticker: white margin, a soft shadow under it, the art on top. */
function DieCut({ children, shape = "circle" }: { children: ReactNode; shape?: "circle" | "blob" }) {
  const outline =
    shape === "circle" ? (
      <circle cx="60" cy="60" r="56" />
    ) : (
      <path d="M60 4 C84 4 98 14 108 30 C118 48 117 74 106 92 C94 110 74 117 56 116 C34 115 16 104 8 84 C0 64 4 38 18 22 C29 10 44 4 60 4 Z" />
    );
  return (
    <>
      <g transform="translate(2 4)" fill="#000" opacity="0.22">
        {outline}
      </g>
      <g fill="#fff">{outline}</g>
      {children}
    </>
  );
}

type Bespoke = "marathon" | "archaeologist" | "polyglot" | "night_owl";

const ART: Record<Bespoke, () => ReactNode> = {
  // «Марафонец»: a film strip running to a chequered flag.
  marathon: () => (
    <DieCut>
      <circle cx="60" cy="60" r="49" fill="#ff7a3d" />
      <circle cx="60" cy="60" r="49" fill="#ffb347" opacity="0.5" transform="translate(-8 -10) scale(0.9) translate(6 6)" />
      <path d="M16 86 C38 70 46 88 66 70 C80 57 86 44 100 40" fill="none" stroke="#2b1a10" strokeWidth="17" strokeLinecap="round" />
      <path d="M16 86 C38 70 46 88 66 70 C80 57 86 44 100 40" fill="none" stroke="#fff3df" strokeWidth="5" strokeDasharray="5 6" strokeLinecap="round" />
      <line x1="84" y1="16" x2="84" y2="46" stroke="#2b1a10" strokeWidth="3.5" strokeLinecap="round" />
      <g transform="translate(85 17)">
        <rect width="24" height="16" fill="#fff" stroke="#2b1a10" strokeWidth="2" />
        <rect width="6" height="4" fill="#2b1a10" />
        <rect x="12" width="6" height="4" fill="#2b1a10" />
        <rect x="6" y="4" width="6" height="4" fill="#2b1a10" />
        <rect x="18" y="4" width="6" height="4" fill="#2b1a10" />
        <rect y="8" width="6" height="4" fill="#2b1a10" />
        <rect x="12" y="8" width="6" height="4" fill="#2b1a10" />
        <rect x="6" y="12" width="6" height="4" fill="#2b1a10" />
        <rect x="18" y="12" width="6" height="4" fill="#2b1a10" />
      </g>
      <path d="M28 30 l3 7 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1 z" fill="#fff3df" />
      <path d="M44 22 l1.5 3.5 3.5 .5 -2.5 2.5 .5 3.5 -3 -1.5 -3 1.5 .5 -3.5 -2.5 -2.5 3.5 -.5 z" fill="#fff3df" opacity="0.8" />
    </DieCut>
  ),
  // «Киноархеолог»: an old reel dug out of the sand, a brush beside it.
  archaeologist: () => (
    <DieCut shape="blob">
      <path d="M60 10 C82 10 96 20 104 34 C113 50 112 72 102 88 C92 104 74 110 57 109 C38 108 22 99 15 82 C8 64 11 42 23 28 C32 17 45 10 60 10 Z" fill="#e9c27b" />
      <path d="M14 78 C34 70 52 80 72 73 C86 68 96 70 108 74 L104 92 C92 106 74 112 57 111 C38 110 22 101 15 84 Z" fill="#c8964c" />
      <path d="M22 88 C38 84 50 90 66 86" fill="none" stroke="#a87634" strokeWidth="2.5" strokeLinecap="round" />
      <g transform="translate(54 56)">
        <circle r="26" fill="#5b3a1e" />
        <circle r="22" fill="#7a5130" />
        <circle r="5" fill="#e9c27b" />
        <circle cx="0" cy="-13" r="5.5" fill="#e9c27b" />
        <circle cx="12.4" cy="-4" r="5.5" fill="#e9c27b" />
        <circle cx="7.6" cy="10.5" r="5.5" fill="#e9c27b" />
        <circle cx="-7.6" cy="10.5" r="5.5" fill="#e9c27b" />
        <circle cx="-12.4" cy="-4" r="5.5" fill="#e9c27b" />
      </g>
      <path d="M14 78 C34 70 52 80 72 73 C86 68 96 70 108 74" fill="none" stroke="#c8964c" strokeWidth="9" />
      <g transform="rotate(-38 92 40)">
        <rect x="88" y="14" width="8" height="34" rx="3" fill="#8a5a2b" />
        <rect x="86" y="44" width="12" height="7" rx="1.5" fill="#c9ccd1" />
        <path d="M86 51 h12 l2 14 h-16 z" fill="#3b2a1a" />
      </g>
      <text x="28" y="38" fontSize="13" fontWeight="800" fill="#7a5130" fontFamily="var(--mt-font-display), sans-serif">
        1959
      </text>
    </DieCut>
  ),
  // «Полиглот»: three speech bubbles in three scripts.
  polyglot: () => (
    <DieCut>
      <circle cx="60" cy="60" r="49" fill="#2fb3a6" />
      <g>
        <path d="M18 30 h46 a8 8 0 0 1 8 8 v20 a8 8 0 0 1 -8 8 h-30 l-10 9 v-9 h-6 a8 8 0 0 1 -8 -8 v-20 a8 8 0 0 1 8 -8 z" fill="#fff" />
        <text x="41" y="58" textAnchor="middle" fontSize="26" fontWeight="800" fill="#1d4d48" fontFamily="var(--mt-font-display), sans-serif">
          Я
        </text>
      </g>
      <g>
        <path d="M58 52 h40 a8 8 0 0 1 8 8 v18 a8 8 0 0 1 -8 8 h-4 v9 l-10 -9 h-26 a8 8 0 0 1 -8 -8 v-18 a8 8 0 0 1 8 -8 z" fill="#ffd34d" />
        <text x="78" y="78" textAnchor="middle" fontSize="23" fontWeight="800" fill="#5a3b00" fontFamily="var(--mt-font-display), sans-serif">
          Ab
        </text>
      </g>
      <g>
        <circle cx="86" cy="30" r="13" fill="#ff8fa3" />
        <text x="86" y="37" textAnchor="middle" fontSize="18" fontWeight="800" fill="#6b1d2b" fontFamily="var(--mt-font-display), sans-serif">
          ñ
        </text>
      </g>
    </DieCut>
  ),
  // «Ночная сова»: an owl with cat-like tufts under a crescent moon.
  night_owl: () => (
    <DieCut>
      <circle cx="60" cy="60" r="49" fill="#202a57" />
      <circle cx="60" cy="60" r="49" fill="#3b2f7a" opacity="0.45" transform="translate(60 60) scale(0.72) translate(-60 -60)" />
      <path d="M86 18 a17 17 0 1 0 12 28 a14 14 0 1 1 -12 -28 z" fill="#ffd76a" />
      <circle cx="26" cy="32" r="1.8" fill="#fff" />
      <circle cx="38" cy="20" r="1.3" fill="#fff" opacity="0.8" />
      <circle cx="98" cy="64" r="1.5" fill="#fff" opacity="0.9" />
      <circle cx="22" cy="62" r="1.2" fill="#fff" opacity="0.7" />
      <path d="M36 98 C30 78 32 52 40 44 L36 30 L50 40 H70 L84 30 L80 44 C88 52 90 78 84 98 Z" fill="#8a5a3c" />
      <path d="M44 98 C42 84 46 74 60 72 C74 74 78 84 76 98 Z" fill="#c99a6e" />
      <path d="M48 80 l4 4 4 -4 4 4 4 -4 4 4 4 -4" fill="none" stroke="#8a5a3c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="50" cy="56" r="10" fill="#fff" />
      <circle cx="70" cy="56" r="10" fill="#fff" />
      <circle cx="51" cy="57" r="5" fill="#1a1a2e" />
      <circle cx="69" cy="57" r="5" fill="#1a1a2e" />
      <circle cx="52.5" cy="55" r="1.6" fill="#fff" />
      <circle cx="70.5" cy="55" r="1.6" fill="#fff" />
      <path d="M56 64 L60 70 L64 64 Z" fill="#ffb03b" />
      <rect x="30" y="97" width="60" height="5" rx="2.5" fill="#5b3a26" />
    </DieCut>
  ),
};

const DISPLAY = { fontFamily: "var(--mt-font-display), sans-serif" };

/**
 * The parametric sticker: a die-cut shape in its palette, a glyph (or big
 * digits), and for counter tiers a metal ring with the goal on a ribbon.
 */
function Parametric({ spec }: { spec: StickerSpec }) {
  const p = PALETTES[spec.hue];
  const paths = SHAPES[spec.shape];
  const metal = spec.tier ? metalFor(spec.tier) : null;
  const ribbon = metal && spec.ribbon ? spec.ribbon : null;
  const cut = (fill: string) => paths.map((d, i) => <path key={i} d={d} fill={fill} stroke={fill} strokeWidth="13" strokeLinejoin="round" />);
  const s = spec.shape === "star" ? 0.95 : ribbon ? 1.1 : 1.3;
  const cy = ribbon ? 53 : spec.shape === "bubble" ? 56 : 60;
  return (
    <>
      <g transform="translate(2 4)" opacity="0.22">
        {cut("#000")}
      </g>
      {cut("#fff")}
      {paths.map((d, i) => (
        <path key={i} d={d} fill={p.bg} />
      ))}
      <g transform="translate(60 60) scale(0.8) translate(-64 -66)" opacity="0.45">
        {paths.map((d, i) => (
          <path key={i} d={d} fill={p.hi} />
        ))}
      </g>
      {spec.shape === "frame" &&
        [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <g key={i} fill="#fff" opacity="0.8">
            <rect x={22 + i * 9} y="21" width="5" height="4" rx="1" />
            <rect x={22 + i * 9} y="95" width="5" height="4" rx="1" />
          </g>
        ))}
      {metal && (
        <>
          <circle cx="60" cy="60" r="42" fill="none" stroke={metal.fill} strokeWidth="4" />
          <circle cx="60" cy="60" r="39.5" fill="none" stroke={metal.dark} strokeWidth="1" opacity="0.45" />
        </>
      )}
      {spec.glyph ? (
        <g transform={`translate(${60 - 24 * s} ${cy - 24 * s}) scale(${s})`}>{GLYPHS[spec.glyph](p)}</g>
      ) : spec.over ? (
        <>
          <text x="60" y="46" textAnchor="middle" fontSize="15" fontWeight="800" fill={p.light} opacity="0.85" style={DISPLAY}>
            {spec.over}
          </text>
          <text x="60" y="80" textAnchor="middle" fontSize="38" fontWeight="900" fill={p.light} stroke={p.ink} strokeWidth="3" paintOrder="stroke" style={DISPLAY}>
            {spec.text}
          </text>
        </>
      ) : (
        <text x="60" y={spec.shape === "star" ? 71 : 75} textAnchor="middle" fontSize={spec.shape === "star" ? 30 : 42} fontWeight="900" fill={p.light} stroke={p.ink} strokeWidth="3" paintOrder="stroke" style={DISPLAY}>
          {spec.text}
        </text>
      )}
      {ribbon && metal && (
        <>
          <path d="M24 84 H96 L91 92 L96 100 H24 L29 92 Z" fill={metal.fill} stroke={metal.dark} strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M31 86.5 H89" stroke={metal.hi} strokeWidth="1.5" strokeLinecap="round" opacity="0.9" />
          <text x="60" y="96.5" textAnchor="middle" fontSize="12" fontWeight="900" fill={metal.dark} letterSpacing="0.5" style={DISPLAY}>
            {ribbon}
          </text>
        </>
      )}
      <path d="M27 40 A36 36 0 0 1 44 23" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.3" />
    </>
  );
}

/** The sticker art alone (an SVG that fills its box). */
export function StickerArt({ id, className = "" }: { id: StickerId; className?: string }) {
  const spec: StickerSpec = SPECS[id];
  return (
    <svg className={`ks-sticker-art ${className}`} viewBox="0 0 120 120" aria-hidden>
      {spec.bespoke ? ART[id as Bespoke]() : <Parametric spec={spec} />}
    </svg>
  );
}

/**
 * An unlocked sticker with its name and the date it was earned, or (with
 * `progress`) a locked counter sticker, faded, with «37 / 50» under a bar.
 */
export function StickerCard({
  id,
  date,
  title,
  progress,
  focused = false,
  showDesc = true,
}: {
  id: StickerId;
  date?: string;
  /** The title that earned it. */
  title?: string | null;
  progress?: { have: number; need: number } | null;
  focused?: boolean;
  showDesc?: boolean;
}) {
  const { t } = useI18n();
  const k = stickerKeys(id);
  return (
    <div
      data-testid={progress ? "sticker-progress" : "sticker"}
      data-sticker={id}
      className={`ks-sticker ${progress ? "ks-locked" : ""} ${focused ? "ks-focused" : ""}`}
      title={t(k.desc)}
    >
      <div className="ks-sticker-pic" style={{ transform: `rotate(${focused || progress ? 0 : stickerTilt(id)}deg)` }}>
        <StickerArt id={id} />
      </div>
      <div className="ks-sticker-name">{t(k.name)}</div>
      {showDesc && <div className="ks-sticker-desc">{t(k.desc)}</div>}
      {progress ? (
        <>
          <div className="ks-bar" aria-hidden>
            <span style={{ transform: `scaleX(${progressShare(progress.have, progress.need)})` }} />
          </div>
          <div className="ks-sticker-date">{progressLabel(progress.have, progress.need)}</div>
        </>
      ) : (
        <div className="ks-sticker-date">
          {date ? ticketDate(date) : ""}
          {title ? ` · ${title}` : ""}
        </div>
      )}
    </div>
  );
}
