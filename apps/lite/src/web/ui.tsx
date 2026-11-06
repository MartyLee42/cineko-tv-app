// Web building blocks: poster cards, horizontal rows, grids, states.
import { useRef, useState, type ReactNode } from "react";
import { img, imgFallback, titleOf, typeOf, yearOf, type TmdbItem } from "../core/tmdb";
import { useT } from "../core/i18n";
import type { Position } from "../core/store";
import { useAsync, useInView } from "../shared/hooks";
import { loadRow, type RowDef } from "../shared/catalog";
import { IconBack, IconChevron, IconFilm, IconStar } from "../shared/icons";
import { Mascot, type Mood } from "../shared/marty";
import { navigate, titleHref } from "./router";

export function Rating({ value }: { value?: number }) {
  if (!value) return null;
  const cls = value >= 7 ? "good" : value >= 5.5 ? "mid" : "low";
  return (
    <span className={`rating ${cls}`}>
      <IconStar size={12} />
      {value.toFixed(1)}
    </span>
  );
}

export function Poster({ path, alt, size = "w342" }: { path?: string | null; alt: string; size?: "w185" | "w342" | "w500" }) {
  return (
    <div className="poster">
      <div className="poster-ph">
        <IconFilm size={34} />
      </div>
      {path ? <img src={img(path, size)} alt={alt} loading="lazy" decoding="async" onError={imgFallback} /> : null}
    </div>
  );
}

export function Card({
  item,
  progress,
  sub,
  href,
  onRemove,
}: {
  item: TmdbItem;
  progress?: Position | number;
  sub?: string;
  href?: string;
  onRemove?: () => void;
}) {
  const t = useT();
  const type = typeOf(item);
  const title = titleOf(item);
  const pct = typeof progress === "number" ? progress : progress && progress.dur ? progress.pos / progress.dur : 0;
  return (
    <a
      className="card"
      href={href ?? titleHref(type, item.id)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(href ?? titleHref(type, item.id));
      }}
    >
      <div className="card-art">
        <Poster path={item.poster_path} alt={title} />
        <Rating value={item.vote_average} />
        {type === "tv" ? <span className="card-tag">{t("series")}</span> : null}
        {pct > 0 ? (
          <div className="card-progress">
            <div style={{ width: `${Math.min(100, Math.max(3, pct * 100))}%` }} />
          </div>
        ) : null}
        {onRemove ? (
          <button
            className="card-remove"
            title={t("remove")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="card-title">{title}</div>
      <div className="card-sub">{sub ?? [yearOf(item), type === "tv" ? t("series") : t("movie")].filter(Boolean).join(" · ")}</div>
    </a>
  );
}

export function Row({ title, children, href, count }: { title: ReactNode; children: ReactNode; href?: string; count?: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };
  const t = useT();
  return (
    <section className="row">
      <div className="row-head">
        <h2>
          {title}
          {count ? <span className="row-count">{count}</span> : null}
        </h2>
        <div className="row-tools">
          {href ? (
            <a
              className="row-all"
              href={href}
              onClick={(e) => {
                e.preventDefault();
                navigate(href);
              }}
            >
              {t("seeAll")} <IconChevron size={14} />
            </a>
          ) : null}
          <button className="row-arrow" aria-label="←" onClick={() => scroll(-1)}>
            <IconBack size={18} />
          </button>
          <button className="row-arrow" aria-label="→" onClick={() => scroll(1)}>
            <IconChevron size={18} />
          </button>
        </div>
      </div>
      <div className="row-scroll" ref={scroller}>
        {children}
      </div>
    </section>
  );
}

export function SkeletonCards({ n = 8 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div className="card skeleton" key={i}>
          <div className="card-art">
            <div className="poster" />
          </div>
          <div className="sk-line" />
          <div className="sk-line short" />
        </div>
      ))}
    </>
  );
}

/** A catalog row loaded when it scrolls into view. */
export function LazyRow({ def }: { def: RowDef }) {
  const t = useT();
  const [ref, seen] = useInView<HTMLDivElement>();
  const q = useAsync(() => (seen ? loadRow(def) : new Promise<never>(() => undefined)), [seen, def.id, t("home")]);
  if (q.error) return null;
  return (
    <div ref={ref}>
      <Row title={t(def.label)} href={`#/list/${def.id}`}>
        {q.data ? q.data.results.slice(0, 20).map((it) => <Card key={`${it.media_type}-${it.id}`} item={it} />) : <SkeletonCards />}
      </Row>
    </div>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid">{children}</div>;
}

export function Empty({ mood = "sleepy", animated, text, children }: { mood?: Mood; animated?: boolean; text: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Mascot mood={mood} animated={animated} size={150} />
      <p>{text}</p>
      {children}
    </div>
  );
}

/** Loading: Cineko's animated loader; `small` = a plain ring (inline / over video). */
export function Spinner({ label, small }: { label?: string; small?: boolean }) {
  return (
    <div className={`spinner-wrap ${small ? "small" : ""}`}>
      {small ? <div className="spinner" /> : <Mascot mood="loading" animated size={130} />}
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const net = /network|fetch|abort|load failed/i.test(msg);
  return (
    <div className="empty error">
      <Mascot mood="error" size={130} />
      <p className="err-title">{t("error")}</p>
      <p className="muted">{net ? t("errorNet") : msg}</p>
      {onRetry ? (
        <button className="btn" onClick={onRetry}>
          {t("retry")}
        </button>
      ) : null}
    </div>
  );
}

/** A popover menu of options (voice, quality…). */
export function Menu<T extends string | number>({
  label,
  icon,
  value,
  options,
  onPick,
  up,
}: {
  label: string;
  icon?: ReactNode;
  value: T | undefined;
  options: { value: T; label: string; hint?: string }[];
  onPick: (v: T) => void;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  return (
    <div className={`menu ${open ? "open" : ""} ${up ? "up" : ""}`}>
      <button className="menu-btn" onClick={() => setOpen((o) => !o)} title={label} aria-haspopup="listbox" aria-expanded={open}>
        {icon}
        <span className="menu-value">{cur?.label ?? label}</span>
      </button>
      {open ? (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu-list" role="listbox">
            <div className="menu-head">{label}</div>
            {options.map((o) => (
              <button
                key={String(o.value)}
                role="option"
                aria-selected={o.value === value}
                className={`menu-item ${o.value === value ? "on" : ""}`}
                onClick={() => {
                  setOpen(false);
                  onPick(o.value);
                }}
              >
                <span>{o.label}</span>
                {o.hint ? <span className="menu-hint">{o.hint}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
