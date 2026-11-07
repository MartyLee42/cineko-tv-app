// The startup intro: ~3 s, once per app start, in the applied design's
// style (Каркас: the wave-terrain mockup; the others their own motif). It
// lies on top of whatever loads underneath and never takes focus: keys skip
// it and are swallowed while it shows, so spatial navigation keeps its spot.
import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { DESIGN_SWATCH, type DesignSetting } from "@martytv/ui";
import { INTRO_FADE_MS, INTRO_MS } from "./logic";
import { SCENE_IMPORTS } from "./sceneImports";
import { watched } from "../chunkReload";
import "./intro.css";

const SCENES = {} as Record<DesignSetting, ComponentType>;
for (const id of Object.keys(SCENE_IMPORTS) as DesignSetting[]) SCENES[id] = lazy(() => watched(SCENE_IMPORTS[id]()).then((m) => ({ default: m.Scene })));

export function StartupIntro({ design, onDone }: { design: DesignSetting; onDone: () => void }) {
  useEffect(() => {
    const done = setTimeout(onDone, INTRO_MS + INTRO_FADE_MS);
    // Capture, before the app's handlers: any key skips (and is used up).
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      onDone();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(done);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onDone]);
  const sw = DESIGN_SWATCH[design];
  const Scene = SCENES[design] ?? SCENES.kinozal;
  return (
    <div data-testid="startup-intro" data-design={design} className="in-root" style={{ background: sw.bg }}>
      <div className="in-stage">
        {/* The design's colour until its scene arrives (usually already here). */}
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </div>
    </div>
  );
}
