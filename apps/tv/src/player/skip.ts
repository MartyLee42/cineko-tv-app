// «Пропустить заставку / пересказ», «Следующая серия» at the credits, and
// the automatic skip (profile setting skip_segments). The ranges come with
// the source (markers: the file's chapters, the provider, TheIntroDB /
// IntroDB); the controller finds the one the position is in.
import { useEffect, useRef, useState } from "react";
import { autoSkipDue, markerKey, type SkipKind, type SkipMode } from "@martytv/media-types";
import { player } from "./controller";

/** How long «Заставка пропущена · OK — вернуть» stays. */
export const UNDO_MS = 6000;
/** How often «Пропускать сами» looks at the position. */
const AUTO_TICK_MS = 500;

export interface SkipUndo {
  kind: Exclude<SkipKind, "ending">;
  /** Where playback was before the skip. */
  at: number;
}

export interface Skip {
  marker: ReturnType<typeof player.skipMarker>;
  undo: SkipUndo | null;
  /** OK: undo the automatic skip, skip the range, or go to the next episode. */
  onOk(): boolean;
}

export interface SkipOptions {
  active: boolean;
  mode: SkipMode;
  /** Series with a next episode (and no «после этой серии» sleep timer). */
  ending: boolean;
  /** The playback (source + episode): auto-skips happen once per range in it. */
  playKey: string;
  autoplay: boolean;
  startCountdown(): void;
  nextEpisode(): void;
}

export function useSkip(o: SkipOptions): Skip {
  const handled = useRef({ key: "", done: new Set<string>() });
  const [undo, setUndo] = useState<(SkipUndo & { key: string }) | null>(null);
  const opts = useRef(o);
  useEffect(() => {
    opts.current = o;
  });
  /** The ranges already acted on in this playback. */
  const done = () => {
    if (handled.current.key !== opts.current.playKey) handled.current = { key: opts.current.playKey, done: new Set() };
    return handled.current.done;
  };

  // «Пропускать сами»: once per range, only when playback has just entered
  // it (a seek or resume into the middle leaves the button).
  useEffect(() => {
    if (o.mode !== "auto" || !o.active) return;
    const id = setInterval(() => {
      const c = opts.current;
      const m = player.skipMarker(c.ending);
      if (!m) return;
      const d = done();
      const k = markerKey(m);
      if (d.has(k)) return;
      d.add(k);
      const pos = player.position();
      if (!autoSkipDue(m, pos)) return;
      if (m.kind === "ending") {
        if (c.autoplay) c.startCountdown();
        return;
      }
      if (player.skipPast(m)) setUndo({ kind: m.kind, at: pos, key: c.playKey });
    }, AUTO_TICK_MS);
    return () => clearInterval(id);
  }, [o.mode, o.active]);

  useEffect(() => {
    if (!undo) return;
    const id = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(id);
  }, [undo]);

  const shownUndo = undo && undo.key === o.playKey ? undo : null;
  return {
    marker: o.active && o.mode !== "off" ? player.skipMarker(o.ending) : null,
    undo: shownUndo,
    onOk() {
      if (shownUndo) {
        setUndo(null);
        return player.seekTo(shownUndo.at);
      }
      const c = opts.current;
      const m = c.active && c.mode !== "off" ? player.skipMarker(c.ending) : null;
      if (!m) return false;
      done().add(markerKey(m));
      if (m.kind === "ending") {
        c.nextEpisode();
        return true;
      }
      return player.skipPast(m);
    },
  };
}
