// «Cineko TV» channel ident: the robot-cat as an old TV set (cat ears, an
// antenna, a screen face) and the wordmark. Colours follow the design tokens.

// Inline (not channel.css): the mark also shows on the «ТВ» screen, outside the channel's chunk.
const ACCENT_FILL = { fill: "rgb(var(--mt-accent))" };
const SCREEN_FILL = { fill: "rgb(var(--mt-bg))" };
const ACCENT_STROKE = { stroke: "rgb(var(--mt-accent))" };

export function ChannelMark({ size = 64, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      {/* antenna */}
      <path d="M32 14 L24 3 M32 14 L40 3" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
      <circle cx="24" cy="3" r="2.6" style={ACCENT_FILL} />
      <circle cx="40" cy="3" r="2.6" style={ACCENT_FILL} />
      {/* ears */}
      <path d="M8 22 L13 9 L22 17 Z" fill="currentColor" />
      <path d="M56 22 L51 9 L42 17 Z" fill="currentColor" />
      {/* the set */}
      <rect x="5" y="15" width="54" height="42" rx="11" fill="currentColor" />
      <rect x="11" y="21" width="42" height="30" rx="7" style={SCREEN_FILL} />
      {/* face on the screen */}
      <circle cx="24" cy="33" r="3.6" style={ACCENT_FILL} />
      <circle cx="40" cy="33" r="3.6" style={ACCENT_FILL} />
      <path d="M28 41 Q32 44.5 36 41" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" style={ACCENT_STROKE} />
      <path d="M14 38 L20 39 M14 42 L20 41 M50 38 L44 39 M50 42 L44 41" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" style={ACCENT_STROKE} />
      {/* feet */}
      <rect x="15" y="57" width="8" height="4" rx="2" fill="currentColor" />
      <rect x="41" y="57" width="8" height="4" rx="2" fill="currentColor" />
    </svg>
  );
}

/** Mark + «Cineko TV» (the «TV» in an accent tag). */
export function ChannelLogo({ size = 64, live }: { size?: number; live?: string }) {
  return (
    <span data-testid="channel-logo" className="cktv-logo inline-flex items-center">
      <ChannelMark size={size} className="text-text" />
      <span className="cktv-wordmark ml-4 font-display font-extrabold leading-none text-text" style={{ fontSize: Math.round(size * 0.62) }}>
        Cineko
        <span className="cktv-tag ml-2 inline-block rounded-[8px] bg-accent px-2 text-on-accent">TV</span>
      </span>
      {live && (
        <span className="cktv-live ml-6 inline-flex items-center rounded-full px-4 py-1 text-[22px] font-semibold uppercase tracking-wider text-text">
          <span className="cktv-live-dot mr-3 inline-block h-[12px] w-[12px] rounded-full" />
          {live}
        </span>
      )}
    </span>
  );
}
