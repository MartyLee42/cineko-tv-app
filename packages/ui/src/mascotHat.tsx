// The mascot's holiday hats (Santa, witch): part of every mascot drawing, so
// apart from the season sprites (those load only with the holiday layer).

/** Мascot hats: drawn inside the mascot's 120×120 viewBox, over the antennae. */
export function MascotHat({ hat }: { hat: "santa" | "witch" }) {
  if (hat === "santa")
    return (
      <g data-hat="santa">
        <path d="M14 34 Q20 6 52 2 Q78 0 92 22 L84 28 Q72 14 60 16 Q74 26 70 34 Z" fill="#d72b32" />
        <path d="M60 16 Q74 26 70 34 L64 34 Q66 24 56 17 Z" fill="#a91d24" />
        <rect x="10" y="27" width="66" height="13" rx="6.5" fill="#f5f5f2" />
        <circle cx="92" cy="24" r="8.5" fill="#f5f5f2" />
      </g>
    );
  return (
    <g data-hat="witch">
      <ellipse cx="60" cy="31" rx="50" ry="7.5" fill="#2a1b40" stroke="#8f6cd6" strokeWidth="1.5" />
      <path d="M32 30 Q44 18 50 6 Q58 -2 78 4 Q66 6 66 16 L84 30 Z" fill="#2a1b40" stroke="#8f6cd6" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M36 25.5 L80 25.5 L83 29 L33 29 Z" fill="#ff8a1f" />
      <rect x="54" y="23" width="9" height="8" rx="1.5" fill="none" stroke="#ffd36a" strokeWidth="2" />
    </g>
  );
}
