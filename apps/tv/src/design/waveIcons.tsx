// «Каркас» (synthwave) icons: angular wireframe line art — straight segments,
// sharp joins, like a vector display — stroked with currentColor; the neon
// glow comes from CSS (.w-icon in index.css), so a focused tab stays crisp.
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "square", strokeLinejoin: "miter", strokeMiterlimit: 8 } as const;

function Svg({ size = 30, stroke = 1.9, children }: { size?: number; stroke?: number; children: React.ReactNode }) {
  return (
    <svg {...base} width={size} height={size} strokeWidth={stroke} className="w-icon" aria-hidden>
      {children}
    </svg>
  );
}

type P = { size?: number; stroke?: number };

/** «Спросить ИИ»: an angular speech bubble with a four-point star. */
export const WaveAskIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h18v11.5h-9.5L6.5 20v-4H3z" />
    <path d="M12 6.8l1.1 2.6 2.6 1.1-2.6 1.1-1.1 2.6-1.1-2.6-2.6-1.1 2.6-1.1z" />
  </Svg>
);

/** «Удиви меня!»: a wireframe cube (isometric) with a pip on top. */
export const WaveDiceIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 2.8l8.2 4.6v9.2L12 21.2l-8.2-4.6V7.4z" />
    <path d="M3.8 7.4L12 12l8.2-4.6M12 12v9.2" />
    <path d="M12 6.3l1.3.8-1.3.8-1.3-.8z" />
    <path d="M7.2 13.2v.1M8.4 16.3v.1M16.8 13.2v.1M15.6 16.3v.1" strokeWidth={2.6} />
  </Svg>
);

/** «Поиск»: an octagonal lens with a straight handle. */
export const WaveSearchIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.8h5l3.5 3.5v5L13 15.8H8l-3.5-3.5v-5z" />
    <path d="M15.6 15.4l5 5" />
  </Svg>
);

/** «Сообщения»: an angular bubble with two scanlines. */
export const WaveMessageIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h18v11.5H10.5L5.5 20v-4H3z" />
    <path d="M7 8.5h10M7 12h6" />
  </Svg>
);

/** «Настройки»: three horizon lines with diamond knobs. */
export const WaveSlidersIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h9.5M18.5 6H21M3 12h2.5M11.5 12H21M3 18h11.5M20.5 18H21" />
    <path d="M15.5 3.5L18 6l-2.5 2.5L13 6zM8.5 9.5L11 12l-2.5 2.5L6 12zM17.5 15.5L20 18l-2.5 2.5L15 18z" />
  </Svg>
);

export const WavePlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v16M4 12h16" />
  </Svg>
);

export const WaveCheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 12.5l5 5L20 6.5" />
  </Svg>
);

/** «Ещё»: three diamonds on a line. */
export const WaveMoreIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 10l2 2-2 2-2-2zM12 10l2 2-2 2-2-2zM19 10l2 2-2 2-2-2z" />
  </Svg>
);

// ---- the text tabs (shown beside their labels)

const OCT = "M8.5 3.5h7l5 5v7l-5 5h-7l-5-5v-7z";

/** «Главная»: an angular house. */
export const WaveHomeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 11.5L12 4l9 7.5M5.5 9.5V20h13V9.5" />
    <path d="M10 20v-5.5h4V20" />
  </Svg>
);

/** «ТВ»: a screen with an antenna and a scanline. */
export const WaveLiveIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 8h18v12H3zM8 3.5L12 8l4-4.5" />
    <path d="M6 14h12" />
  </Svg>
);

/** «Видео»: a screen with a play triangle. */
export const WaveVideoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 5h19v14h-19z" />
    <path d="M10 9v6l5-3z" />
  </Svg>
);

/** «Обзор»: an octagonal compass. */
export const WaveExploreIcon = (p: P) => (
  <Svg {...p}>
    <path d={OCT} />
    <path d="M15.5 8.5l-2 5-5 2 2-5z" />
  </Svg>
);

/** «Фильмы»: a film strip. */
export const WaveFilmIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 3.5h16v17H4zM8 3.5v17M16 3.5v17" />
    <path d="M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4" />
  </Svg>
);

/** «Сериалы»: stacked screens. */
export const WaveSeriesIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 9h14v11H3z" />
    <path d="M6.5 5.5H21v11" />
  </Svg>
);

/** «Новые серии»: an angular screen with a sharp spark. */
export const WaveNewIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 7h14v11H3z" />
    <path d="M7.5 21h5" />
    <path d="M19.5 2.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  </Svg>
);

/** «История»: an octagonal clock. */
export const WaveHistoryIcon = (p: P) => (
  <Svg {...p}>
    <path d={OCT} />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

/** «Моё»: an angular bookmark. */
export const WaveMineIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 3.5h12v17l-6-4.5-6 4.5z" />
  </Svg>
);

// ---- emoji → line art (Обзор moods / themes, «Удиви меня!», «Спросить ИИ»)

const FACE = OCT;
/** Each emoji's drawing (24×24, straight segments); a dot is a zero-length segment. */
const GLYPHS: Record<string, string[]> = {
  "☕": ["M5 9h11v6.5L13.5 19h-6L5 16.5z", "M16 10.5h2.5v4H16", "M8.5 3.5l1 1.5-1 1.5M12 3.5l1 1.5-1 1.5"],
  "😰": [FACE, "M9 10v.1M15 10v.1", "M8.5 15.5l1.75-1 1.75 1 1.75-1 1.75 1"],
  "😂": [FACE, "M7.5 10.5l1.5-1.5 1.5 1.5M13.5 10.5l1.5-1.5 1.5 1.5", "M8 13.5h8l-1.5 3h-5z"],
  "🤔": [FACE, "M9 10v.1M15 9.5v.1", "M9.5 15.5l5-1.2"],
  "👻": ["M5 21V10l3.5-6h7L19 10v11l-2.3-2-2.3 2-2.4-2-2.3 2-2.4-2z", "M9.5 10.5v1.5M14.5 10.5v1.5"],
  "💕": ["M12 20L3.5 11.5V7L7 3.5h2l3 3 3-3h2L20.5 7v4.5z"],
  "👨‍👩‍👧": ["M6 3.5l1.5 1.5L6 6.5 4.5 5z", "M18 3.5l1.5 1.5L18 6.5 16.5 5z", "M12 9l1.25 1.25L12 11.5l-1.25-1.25z", "M2.5 20L6 9l3.5 11M14.5 20L18 9l3.5 11M9.5 20l2.5-6 2.5 6"],
  "⏳": ["M5 3h14M5 21h14", "M7 3h10l-5 9 5 9H7l5-9z", "M10 18.5h4"],
  "💰": ["M7 4h10l4 5-9 11L3 9z", "M3 9h18", "M9.5 4L8 9l4 11 4-11-1.5-5"],
  "🏙": ["M2 21h20", "M4 21V11h4v10M8 21V5h5v16M13 21V9h4v12M17 21v-8h3v8"],
  "🚀": ["M12 2.5l4 5v8H8v-8z", "M8 11.5l-3 4v3.5l3-2M16 11.5l3 4v3.5l-3-2", "M10.5 18.5l1.5 3 1.5-3", "M12 9.5v.1"],
  "🤖": ["M5 8h14v11H5z", "M12 4v4", "M9 11.5v1.5M15 11.5v1.5", "M9 16h6", "M3 11.5v4M21 11.5v4"],
  "☢": ["M12 3l9.5 17h-19z", "M12 9.5v5", "M12 17v.1"],
  "🧠": ["M12 4v16", "M12 4H8L4.5 7.5v4L6 13l-1.5 2v2L7.5 20H12", "M12 4h4l3.5 3.5v4L18 13l1.5 2v2L16.5 20H12", "M7.5 9H10M14 15h2.5"],
  "🌀": ["M12 12h3v3H9V9h9v9H6V6h15"],
  "📰": ["M4 4h13v16H4z", "M17 8h3v10.5L18.5 20H17", "M7 8h7M7 11h7M7 14h7M7 17h4"],
  "🔪": ["M3 21l5-5", "M6 14l4 4", "M8 16L19.5 3.5l1 4L10 18"],
  "🕵": ["M2.5 11.5h19", "M6 11.5L7.5 5h9l1.5 6.5", "M5 15.5h5v3.5H5zM14 15.5h5v3.5h-5z", "M10 17h4"],
  "🎩": ["M7 4h10v11H7z", "M3 15h18v2.5H3z", "M7 11.5h10"],
  "🖤": ["M12 20L3.5 11.5V7L7 3.5h2l3 3 3-3h2L20.5 7v4.5z", "M12 6.5l-1.5 4 2.5 2-2 4"],
  "🎒": ["M6 8l2-3h8l2 3v12.5H6z", "M9 5V3.5h6V5", "M8.5 13h7v4.5h-7z"],
  "🚗": ["M2.5 16v-4l3-4.5h10l3.5 4.5h2.5v4h-2.5M7 16h8M4.5 16h-2", "M7 14l2 2-2 2-2-2zM17 14l2 2-2 2-2-2z", "M7 12h11.5"],
  "🏕": ["M2.5 20L12 4l9.5 16z", "M12 20l-3-6h6z"],
  "🌈": ["M2.5 19v-4.5L7 10h10l4.5 4.5V19", "M6.5 19v-2.5l2-2h7l2 2V19"],
  "🎄": ["M12 2.5l5 6h-2.5l4 5.5h-3l4 5.5H4.5l4-5.5h-3l4-5.5H7z", "M12 19.5V22"],
  "🧟": [FACE, "M8 9l2 2M10 9l-2 2M14 9l2 2M16 9l-2 2", "M8.5 15.5h7M10.5 15.5V17M13.5 15.5V17"],
  "🦸": ["M12 2.5l8 3V12l-8 9.5L4 12V5.5z", "M13 6.5l-3.5 6h3L11 17.5l4-6.5h-3z"],
  "🎲": ["M12 2.8l8.2 4.6v9.2L12 21.2l-8.2-4.6V7.4z", "M3.8 7.4L12 12l8.2-4.6M12 12v9.2", "M12 6.3l1.3.8-1.3.8-1.3-.8z"],
  "🍿": ["M5 9h14l-2 12H7z", "M9.5 9l.5 12M14.5 9l-.5 12", "M5 9l1.5-3 2.5-.5L10.5 3l2.5.5 2.5-1L17 5l2.5.5L19 9"],
  "📺": ["M3 8h18v12H3zM8 3.5L12 8l4-4.5", "M6 14h12"],
  "🏡": ["M3 11.5L12 4l9 7.5M5.5 9.5V20h13V9.5", "M10 20v-5.5h4V20"],
  "📱": ["M7 2.5h10v19H7z", "M10.5 18.5h3"],
  "⌨": ["M2.5 7h19v11h-19z", "M5.5 10.5h1M9 10.5h1M12.5 10.5h1M16 10.5h1", "M7 14.5h10"],
};

/** The line drawing for an emoji, or null when there is none. */
export function waveGlyph(emoji: string, size: number, stroke = 1.8): React.ReactNode {
  const paths = GLYPHS[emoji.replace(/️/g, "")];
  if (!paths) return null;
  return (
    <Svg size={size} stroke={stroke}>
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </Svg>
  );
}

// ---- Обзор tiles without an emoji: decades, countries, genres, collections

const SPARK = ["M12 2.5l2.2 7.3 7.3 2.2-7.3 2.2-2.2 7.3-2.2-7.3L2.5 12l7.3-2.2z", "M19 3v3M17.5 4.5h3"];
const MEDAL = ["M12 3l2.5 5.5 6 .5-4.5 4 1.5 6L12 16l-5.5 3 1.5-6-4.5-4 6-.5z"];
const BANG = ["M12 2l2 6 6-3-3 6 6 2-6 2 3 6-6-3-2 6-2-6-6 3 3-6-6-2 6-2-3-6 6 3z"];
const UFO = ["M2.5 14L7 10.5h10l4.5 3.5-4.5 3H7z", "M9 10.5l1.5-4h3l1.5 4", "M7 20l1-3M17 20l-1-3"];
const MASK = ["M3.5 4h10v7l-5 4-5-4z", "M6.5 7.5h1M10 7.5h1", "M6.5 11l2-1 2 1", "M14.5 8.5h6v7l-4 4-4-3"];
const FILM_CAM = ["M3 7h13v10H3z", "M16 10l5-3v10l-5-3"];

const GENRES: Record<string, string[]> = {
  "28": BANG,
  "10759": BANG,
  "12": ["M2 20l7-12 4 6 3-4 6 10z", "M9 8V3l4 1.5L9 6"],
  "16": SPARK,
  "35": GLYPHS["😂"]!,
  "80": GLYPHS["🕵"]!,
  "99": FILM_CAM,
  "18": MASK,
  "10751": GLYPHS["👨‍👩‍👧"]!,
  "10762": GLYPHS["🎒"]!,
  "14": ["M4 21V9h3v3h3V9h4v3h3V9h3v12z", "M10 21v-5h4v5", "M12 3v6"],
  "36": ["M3 9l9-5 9 5z", "M5 9v9M9.5 9v9M14.5 9v9M19 9v9", "M3 20h18"],
  "27": GLYPHS["👻"]!,
  "10402": ["M9 18V5l11-2v13", "M9 18l-3 2.5L3.5 18 6 15.5zM20 16l-3 2.5-2.5-2.5 2.5-2.5z"],
  "9648": ["M8 7l2-3h4l2 3v2.5l-4 3V15", "M12 19v.1"],
  "10749": GLYPHS["💕"]!,
  "10766": GLYPHS["💕"]!,
  "878": UFO,
  "10765": UFO,
  "53": GLYPHS["😰"]!,
  "10752": MEDAL,
  "10768": MEDAL,
  "37": ["M2 15l3 2.5h14l3-2.5", "M6 15l1.5-8 3 1.5h3l3-1.5L18 15z"],
  "10770": GLYPHS["📺"]!,
  "10764": GLYPHS["📺"]!,
  "10763": GLYPHS["📰"]!,
  "10767": ["M3 4.5h18v11.5H10.5L5.5 20v-4H3z", "M7 8.5h10M7 12h6"],
};
const KINDS: Record<string, string[]> = {
  decade: ["M2.5 6h19v12h-19z", "M6 10h3v4H6zM15 10h3v4h-3z", "M9 12h6", "M7 18l1.5-2h7l1.5 2"],
  language: [OCT, "M12 3.5L9 12l3 8.5 3-8.5z", "M4.5 8.5h15M4.5 15.5h15"],
  collection: SPARK,
  // «Подборки»: a list on a page.
  curated: ["M5.5 3.5h13v17h-13z", "M8.5 8h7M8.5 11.5h7M8.5 15h4"],
};

/** A line drawing for an Обзор tile: its emoji, else its genre / kind. */
export function waveTileGlyph(tile: { id: string; kind: string; emoji?: string | null }, size: number): React.ReactNode {
  if (tile.emoji) {
    const g = waveGlyph(tile.emoji, size);
    if (g) return g;
  }
  const genre = tile.kind === "genre" ? GENRES[tile.id.slice(tile.id.indexOf(":") + 1)] : undefined;
  const paths = genre ?? KINDS[tile.kind] ?? SPARK;
  return (
    <Svg size={size} stroke={1.8}>
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </Svg>
  );
}
