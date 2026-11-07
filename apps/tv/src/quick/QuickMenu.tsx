// Quick actions on a poster card without opening it: hold OK (or ☰ / Info)
// on a focused card. ♥ «Нравится» and «Буду смотреть» toggle in place, the
// rating line picks 1–10 with ◀ ▶ (OK saves, then the popup closes), «Не
// интересно», «Подробнее». ▲▼ move, Back closes. Drawn with theme tokens and
// the shared .tv-focus ring, so every design / skin styles it.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { initialPick, imageUrl, placeholderColor, ratingChange, RATING_MAX, stepRating } from "@martytv/media-types";
import { useI18n, type MessageKey } from "@martytv/ui";
import { getCurrentFocusKey } from "../focus";
import { useCatalogConfig } from "../catalog/queries";
import { Img, legacyColor } from "../components/Img";
import { DismissWhy } from "../foryou/DismissWhy";
import { playerKey } from "../player/keys";
import { claimKeys, keysClaimed } from "../remote/keyOwner";
import { notInterested, setListed, setRating } from "./data";
import { isQuickKey, moveLine, quickLines, type QuickLine } from "./logic";
import { quickMenu, type QuickTarget } from "./store";

/** Mounted once: the popup, «Почему?» after a generic «Не интересно», and the ☰ / Info key on focused cards. */
export function QuickLayer() {
  const target = useSyncExternalStore(quickMenu.subscribe, quickMenu.get);
  const [why, setWhy] = useState<{ mediaId: string; title: string } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isQuickKey(e) || quickMenu.get() || keysClaimed()) return;
      const t = quickMenu.focusedTarget(getCurrentFocusKey());
      if (!t) return;
      e.preventDefault();
      quickMenu.open(t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      {target && (
        <QuickMenu
          key={target.item.id}
          target={target}
          onClose={() => quickMenu.close()}
          onDismissed={(t) => {
            quickMenu.close();
            if (t.onDismiss) return t.onDismiss();
            notInterested(t.item, t.rowId);
            setWhy({ mediaId: t.item.id, title: t.item.title });
          }}
        />
      )}
      {why && <DismissWhy mediaId={why.mediaId} title={why.title} onClose={() => setWhy(null)} />}
    </>
  );
}

function QuickMenu({ target, onClose, onDismissed }: { target: QuickTarget; onClose: () => void; onDismissed: (t: QuickTarget) => void }) {
  const { t } = useI18n();
  const cfg = useCatalogConfig();
  const { item } = target;
  const me = item.me;
  const lines = quickLines({ dismiss: true, open: !!target.onOpen });
  const [index, setIndex] = useState(0);
  const [liked, setLiked] = useState(!!me?.favorite);
  const [wanted, setWanted] = useState(!!me?.in_watchlist);
  const [rating, setRatingState] = useState<number | null>(me?.rating ?? null);
  const [pick, setPick] = useState(() => initialPick(me?.rating));
  const [saved, setSaved] = useState<string | null>(null);
  const st = useRef({ index, liked, wanted, rating, pick, saved, lines });
  useEffect(() => {
    st.current = { index, liked, wanted, rating, pick, saved, lines };
  });

  useEffect(() => {
    const c = claimKeys();
    // Opened by holding OK: the held key keeps auto-repeating (not every engine
    // flags e.repeat), so OK counts only after a key-up (or a second).
    let armed = false;
    const arm = () => (armed = true);
    const armTimer = setTimeout(arm, 1000);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const run = (line: QuickLine) => {
      const s = st.current;
      if (line === "like") {
        setLiked(!s.liked);
        void setListed("favorites", item.id, !s.liked);
      } else if (line === "want") {
        setWanted(!s.wanted);
        void setListed("watchlist", item.id, !s.wanted);
      } else if (line === "rate") {
        const ch = ratingChange(s.pick, s.rating);
        if (ch) {
          setRatingState(ch.rating);
          void setRating(item.id, ch.rating, s.rating);
        }
        if (!ch && s.pick === 0) return onClose();
        setSaved(s.pick === 0 ? t("quick.unrated") : t("quick.rated", { n: s.pick }));
        closeTimer = setTimeout(onClose, 700);
      } else if (line === "dismiss") onDismissed(target);
      else if (line === "open") {
        onClose();
        target.onOpen?.();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      if (isQuickKey(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return onClose();
      }
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const s = st.current;
      if (s.saved) return;
      const line = s.lines[s.index]!;
      if (k === "up") setIndex(moveLine(s.index, -1, s.lines.length));
      else if (k === "down") setIndex(moveLine(s.index, 1, s.lines.length));
      else if ((k === "left" || k === "right") && line === "rate") setPick(stepRating(s.pick, k === "left" ? -1 : 1));
      else if (k === "ok" || k === "play" || k === "playpause") {
        if (armed && !e.repeat) run(line);
      } else if (k === "back" || k === "stop") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", arm, true);
    return () => {
      clearTimeout(armTimer);
      clearTimeout(closeTimer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", arm, true);
      c.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sub = [item.year, t(`catalog.kind.${item.kind}` as MessageKey)].filter(Boolean).join(" · ");
  const line = (key: QuickLine, i: number, children: React.ReactNode, on = false) => (
    <div
      key={key}
      data-quick={key}
      data-on={on ? "" : undefined}
      className={`tv-focus flex items-center ${i > 0 ? "mt-4" : ""} rounded-control px-9 py-5 text-[34px] font-semibold ${i === index ? "is-focused" : ""} ${on ? "bg-accent text-on-accent" : "bg-surface-2"}`}
    >
      {children}
    </div>
  );
  return (
    <div data-testid="tv-quick" className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] items-center justify-center bg-black/60">
      <div className="flex w-[1240px] rounded-card bg-surface px-14 py-12 shadow-2xl">
        <div className="relative shrink-0 overflow-hidden rounded-2xl" style={{ width: 240, height: 360, background: legacyColor(placeholderColor(item.id)) }}>
          <Img src={imageUrl(cfg.data, item.poster_path, "w342")} className="absolute left-0 top-0 h-full w-full object-cover" />
        </div>
        <div className="ml-12 min-w-0 flex-1">
          <h2 className="line-clamp-2 text-[46px] font-bold leading-tight">{item.title}</h2>
          {sub && <p className="mt-2 truncate text-[26px] text-muted">{sub}</p>}
          <div className="mt-8">
            {lines.map((key, i) => {
              if (key === "like")
                return line(
                  key,
                  i,
                  <>
                    <span className={`mr-5 w-10 text-center ${liked ? "" : "opacity-60"}`}>♥</span>
                    <span className="flex-1">{t("quick.like")}</span>
                    {liked && <span className="ml-4">✓</span>}
                  </>,
                  liked,
                );
              if (key === "want")
                return line(
                  key,
                  i,
                  <>
                    <span className="mr-5 w-10 text-center">{wanted ? "✓" : "+"}</span>
                    <span className="flex-1">{t("quick.want")}</span>
                    {wanted && <span className="ml-4">✓</span>}
                  </>,
                  wanted,
                );
              if (key === "rate") return <RateLine key={key} first={i === 0} focused={i === index} pick={pick} rating={rating} saved={saved} />;
              if (key === "dismiss")
                return line(
                  key,
                  i,
                  <>
                    <span className="mr-5 w-10 text-center">✕</span>
                    {t("fy.dismiss")}
                  </>,
                );
              return line(
                key,
                i,
                <>
                  <span className="mr-5 w-10 text-center">→</span>
                  {t("quick.open")}
                </>,
              );
            })}
          </div>
          <p className="mt-7 text-[22px] text-muted">{t("quick.hint")}</p>
        </div>
      </div>
    </div>
  );
}

/** ★★★★★★★☆☆☆ 7 — the picked value while focused, the saved one otherwise. */
function RateLine({ first, focused, pick, rating, saved }: { first: boolean; focused: boolean; pick: number; rating: number | null; saved: string | null }) {
  const { t } = useI18n();
  const shown = focused ? pick : (rating ?? 0);
  return (
    <div data-quick="rate" data-pick={pick} className={`tv-focus ${first ? "" : "mt-4"} rounded-control bg-surface-2 px-9 py-4 ${focused ? "is-focused" : ""}`}>
      <div className="flex items-center">
        <span className="text-[24px] font-semibold text-muted">{t("quick.rating")}</span>
        <span className="ml-auto text-[30px] font-bold">{saved ?? (shown > 0 ? `★ ${shown}` : t("quick.rating_none"))}</span>
      </div>
      <div className="mt-2 flex items-center">
        {focused && <span className={`mr-3 text-[26px] ${pick > 0 ? "text-text" : "text-text/25"}`}>◀</span>}
        {Array.from({ length: RATING_MAX }, (_, i) => (
          <span key={i} data-star={i + 1} className={`mr-1 text-center text-[46px] leading-none ${i < shown ? "text-accent" : "text-text/20"}`} style={{ width: 52 }}>
            ★
          </span>
        ))}
        {focused && <span className={`ml-2 text-[26px] ${pick < RATING_MAX ? "text-text" : "text-text/25"}`}>▶</span>}
      </div>
    </div>
  );
}
