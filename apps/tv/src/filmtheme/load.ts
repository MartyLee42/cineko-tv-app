// «Тема под фильм»: each theme's CSS is a chunk of its own, fetched when a
// title with that theme opens (Details, the player's loader). Nothing waits
// for it: the screen renders in the design and gets data-film-theme once the
// chunk is here.
import { useEffect, useState } from "react";
import { filmTheme, type FilmTheme, type FilmThemeInput } from "@martytv/media-types";
import { useSettings } from "../profile/settings";
import { watched } from "../chunkReload";

const imports: Record<FilmTheme, () => Promise<unknown>> = {
  silent: () => import("./themes/silent"),
  classic: () => import("./themes/classic"),
  noir: () => import("./themes/noir"),
  soviet_toon: () => import("./themes/soviet_toon"),
  soviet: () => import("./themes/soviet"),
  anime: () => import("./themes/anime"),
  western: () => import("./themes/western"),
  horror: () => import("./themes/horror"),
  eighties: () => import("./themes/eighties"),
  scifi: () => import("./themes/scifi"),
};

const loaded = new Set<FilmTheme>();
const loads: Partial<Record<FilmTheme, Promise<unknown>>> = {};

/** Fetches a theme's chunk (once; a failure is retried next time). */
export function loadFilmTheme(t: FilmTheme): Promise<unknown> {
  return (loads[t] ??= watched(imports[t]()).then(
    () => loaded.add(t),
    (e: unknown) => {
      delete loads[t];
      throw e;
    },
  ));
}

/**
 * The film theme to put on a screen's root (`data-film-theme`): null while
 * the profile's «Тема под фильм» is off, the title has none, or its chunk is
 * still on the way.
 */
export function useFilmTheme(d: FilmThemeInput | null | undefined): FilmTheme | null {
  const on = useSettings().film_theme;
  const theme = on ? filmTheme(d) : null;
  const [ready, setReady] = useState<FilmTheme | null>(null);
  useEffect(() => {
    if (!theme || loaded.has(theme)) return;
    let alive = true;
    loadFilmTheme(theme).then(
      () => alive && setReady(theme),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [theme]);
  return theme && (loaded.has(theme) || ready === theme) ? theme : null;
}
