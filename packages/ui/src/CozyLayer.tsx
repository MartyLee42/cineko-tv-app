// «Уютный режим» on Home, the sibling of the holiday SeasonLayer: soft rain
// running down the glass, or a fireplace's warm glow at the bottom with a
// few sparks drifting up, plus (optionally) its quiet synthesised sound.
//
// Performance: like SeasonLayer, every moving element is one span animated
// with a transform/opacity-only keyframe; the glow is two gradient layers
// flickering in opacity. No filters, no blur. Static mode (reduced / calm
// motion) draws the glow and a few drops in place; the hidden page pauses
// every animation and the sound.
import { memo, useEffect, useMemo } from "react";
import { makeCozyParticles, type CozyAmbience, type CozyPlatform } from "./cozy";
import { useCozySound } from "./cozyAudio";
import { useDocumentHidden } from "./seasonStore";

/** Toggles the warm, dimmed palette (html.mt-cozy) while mounted with `on`. */
export function useCozyPalette(on: boolean): void {
  useEffect(() => {
    if (!on || typeof document === "undefined") return;
    const root = document.documentElement;
    root.classList.add("mt-cozy");
    return () => root.classList.remove("mt-cozy");
  }, [on]);
}

export interface CozyLayerProps {
  ambience: Exclude<CozyAmbience, "off">;
  mode: "full" | "static";
  platform: CozyPlatform;
  /** Play the ambience's sound (starts on the first user gesture). */
  sound?: boolean;
  /** Web: fixed to the viewport (default); TV: absolute in the parent. */
  fixed?: boolean;
  narrow?: boolean;
}

/** The overlay: above the page's content, below the holiday layer and dialogs. */
export const CozyLayer = memo(function CozyLayer({ ambience, mode, platform, sound = false, fixed = platform === "web", narrow = false }: CozyLayerProps) {
  const hidden = useDocumentHidden();
  const still = mode === "static";
  const parts = useMemo(() => makeCozyParticles(ambience, platform, narrow), [ambience, platform, narrow]);
  useCozySound(ambience, sound && !hidden);
  const cls = `mt-cz mt-cz-${platform} mt-cz-${ambience} ${fixed ? "mt-cz-fixed" : ""} ${still ? "mt-cz-still" : ""}`;
  return (
    <div className={cls} data-testid="cozy-layer" data-ambience={ambience} data-cozy-mode={mode} data-paused={hidden ? "1" : undefined} aria-hidden>
      {ambience === "fireplace" ? (
        <>
          <div className="mt-cz-glow mt-cz-glow-a" />
          <div className="mt-cz-glow mt-cz-glow-b" />
          {!still &&
            parts.moving.map((p, i) => (
              <span
                key={i}
                className={`mt-cz-spark mt-cz-spark-${i % 2 ? "b" : "a"}`}
                style={{ left: `${p.left}%`, width: p.size, height: p.size, opacity: p.opacity, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }}
              />
            ))}
        </>
      ) : (
        <>
          <div className="mt-cz-haze" />
          {!still &&
            parts.moving.map((p, i) => (
              <span key={i} className="mt-cz-streak" style={{ left: `${p.left}%`, height: p.size, opacity: p.opacity, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }} />
            ))}
          {parts.drops.map((p, i) => (
            <span
              key={`d${i}`}
              className={`mt-cz-drop ${still ? "" : "mt-cz-slide"}`}
              style={{ left: `${p.left}%`, top: `${p.top}%`, width: p.size, height: Math.round(p.size * 1.25), opacity: p.opacity, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }}
            />
          ))}
        </>
      )}
    </div>
  );
});
