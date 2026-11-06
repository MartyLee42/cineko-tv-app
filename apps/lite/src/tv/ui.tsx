// TV building blocks: focusables, poster cards, rows.
import { createContext, useContext, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { img, imgFallback, titleOf, typeOf, yearOf, type TmdbItem } from "../core/tmdb";
import { useT } from "../core/i18n";
import { IconFilm, IconStar } from "../shared/icons";
import { ensure, focusInitial } from "./nav";
import { Mascot, type Mood } from "../shared/marty";

export type Screen =
  | { name: "home" }
  | { name: "search" }
  | { name: "favorites" }
  | { name: "history" }
  | { name: "settings" }
  | { name: "list"; row: string }
  | { name: "title"; type: "movie" | "tv"; id: number }
  | { name: "play"; type: "movie" | "tv"; id: number; season?: number; episode?: number; fromStart?: boolean };

export interface Nav {
  push: (s: Screen) => void;
  replace: (s: Screen) => void;
  back: () => void;
  section: (s: Screen) => void;
  /** Focus key remembered for the current screen (when coming back to it). */
  remembered?: string;
}

export const NavCtx = createContext<Nav>({ push: () => undefined, replace: () => undefined, back: () => undefined, section: () => undefined });
export const useNav = () => useContext(NavCtx);

/** Focuses the remembered element (or [data-autofocus]) once `ready`. */
export function useScreenFocus(ready: boolean, scope: React.RefObject<HTMLElement | null>) {
  const nav = useNav();
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    // Wait for layout (images, rows) before measuring.
    requestAnimationFrame(() => focusInitial(nav.remembered, scope.current));
  });
}

export function F({
  fk,
  onPress,
  onFocus,
  className = "",
  children,
  autoFocus,
  style,
  disabled,
  isDefault,
}: {
  fk: string;
  /** Focus lands here when entering its group for the first time. */
  isDefault?: boolean;
  onPress?: () => void;
  onFocus?: () => void;
  className?: string;
  children?: ReactNode;
  autoFocus?: boolean;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onFocus);
  cb.current = onFocus;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => cb.current?.();
    el.addEventListener("tvfocus", h);
    return () => {
      el.removeEventListener("tvfocus", h);
      // The focused element went away (list re-rendered): put focus back somewhere sensible.
      if (el.hasAttribute("data-focused")) requestAnimationFrame(() => ensure());
    };
  }, []);
  return (
    <div
      ref={ref}
      data-f=""
      data-fk={fk}
      data-autofocus={autoFocus ? "" : undefined}
      data-default={isDefault ? "" : undefined}
      aria-disabled={disabled ? "true" : undefined}
      className={`f ${className}`}
      style={style}
      onClick={disabled ? undefined : onPress}
    >
      {children}
    </div>
  );
}

export function Rating({ value }: { value?: number }) {
  if (!value) return null;
  return (
    <span className={`rating ${value >= 7 ? "good" : value >= 5.5 ? "mid" : "low"}`}>
      <IconStar size={20} />
      {value.toFixed(1)}
    </span>
  );
}

export function PosterCard({
  item,
  fk,
  onPress,
  onFocus,
  progress,
  sub,
  autoFocus,
}: {
  item: TmdbItem;
  fk: string;
  autoFocus?: boolean;
  onPress: () => void;
  onFocus?: () => void;
  progress?: number;
  sub?: string;
}) {
  const t = useT();
  const type = typeOf(item);
  return (
    <F fk={fk} className="pcard" onPress={onPress} onFocus={onFocus} autoFocus={autoFocus}>
      <div className="pcard-art">
        <div className="pcard-ph">
          <IconFilm size={48} />
        </div>
        {item.poster_path ? <img src={img(item.poster_path, "w342")} alt="" onError={imgFallback} /> : null}
        {item.vote_average ? <span className="pcard-rating">{item.vote_average.toFixed(1)}</span> : null}
        {type === "tv" ? <span className="pcard-tag">{t("series")}</span> : null}
        {progress && progress > 0 ? (
          <div className="bar">
            <div style={{ width: `${Math.min(100, Math.max(3, progress * 100))}%` }} />
          </div>
        ) : null}
      </div>
      <div className="pcard-title">{titleOf(item)}</div>
      <div className="pcard-sub">{sub ?? [yearOf(item), type === "tv" ? t("series") : t("movie")].filter(Boolean).join(" · ")}</div>
    </F>
  );
}

export function Row({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="trow" data-row="" data-group={id}>
      <h2 className="trow-title">{title}</h2>
      <div className="trow-scroll" data-scroll="x" data-pad="80">
        <div className="trow-track">{children}</div>
      </div>
    </section>
  );
}

export function Loader({ label }: { label?: string }) {
  return (
    <div className="tloader">
      <Mascot mood="loading" animated size={180} />
      {label ? <div>{label}</div> : null}
    </div>
  );
}

export function Empty({ text, mood = "sleepy", animated }: { text: string; mood?: Mood; animated?: boolean }) {
  return (
    <div className="tempty">
      <Mascot mood={mood} animated={animated} size={220} />
      <div>{text}</div>
    </div>
  );
}
