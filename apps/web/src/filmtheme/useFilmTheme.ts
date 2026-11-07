// «Тема под фильм» on the PWA: the title page's hero takes the film's look.
// All ten themes are one small lazy chunk (styles.ts); the hero renders in the
// design and gets data-film-theme once it's here.
import { useEffect, useState } from "react";
import { filmTheme, type FilmTheme, type FilmThemeInput } from "@martytv/media-types";
import { useSettings } from "../watch/queries";

let ready = false;
let loading: Promise<unknown> | null = null;

function load(): Promise<unknown> {
  return (loading ??= import("./styles").then(
    () => {
      ready = true;
    },
    (e: unknown) => {
      loading = null;
      throw e;
    },
  ));
}

export function useFilmTheme(d: FilmThemeInput | null | undefined): FilmTheme | null {
  const on = useSettings().film_theme ?? false;
  const theme = on ? filmTheme(d) : null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!theme || ready) return;
    let alive = true;
    load().then(
      () => alive && setTick((n) => n + 1),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [theme]);
  return theme && ready ? theme : null;
}
