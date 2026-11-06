import { useEffect, useRef, useState } from "react";
import { useI18n } from "@martytv/ui";
import { FocusButton, FocusSection, setFocus } from "../focus";
import { applyKey, physicalKey, type KeyAction, type Layout } from "../catalog/keyboard";
import { KEYBOARD_WIDTH, ScreenKeyboard } from "../components/ScreenKeyboard";
import { claimKeys } from "../remote/keyOwner";
import { playerKey } from "./keys";
import { cachedMedia, type Refine } from "./data";
import { refineDefault, refineValid, stripYear, withSeason } from "./refine";
import type { PlayContext } from "./session";

/**
 * «Уточнить поиск»: edit the release search text with the on-screen keyboard
 * (pre-filled with the title + year), quick edits, the «Неточные совпадения»
 * toggle, then «Искать». Back closes it.
 */
export function RefineScreen({ ctx, initial, onSearch, onClose }: { ctx: PlayContext; initial: Refine | null; onSearch: (r: Refine) => void; onClose: () => void }) {
  const { t, locale } = useI18n();
  const media = cachedMedia(ctx.media_id, ctx.lang);
  const [text, setText] = useState(() => initial?.text ?? refineDefault(ctx.title || media?.title || "", media?.year));
  const [loose, setLoose] = useState(initial?.loose ?? false);
  const [layout, setLayout] = useState<Layout>(locale === "ru" ? "ru" : "en");
  const [error, setError] = useState(false);
  const edit = (a: KeyAction) => {
    setError(false);
    setText((p) => applyKey(p, a));
  };
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // Back closes; a physical keyboard types too (Backspace edits while there is text).
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const a = physicalKey(e.key ?? "", e.ctrlKey || e.metaKey || e.altKey);
      if (a && !(a.type === "backspace" && textRef.current === "")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return edit(a);
      }
      if (playerKey(e) === "back") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    void setFocus("refine-search");
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, []);

  const search = () => {
    if (!refineValid(text)) return setError(true);
    onSearch({ text: text.trim(), loose });
  };
  const chips: { key: string; label: string; apply: () => void }[] = [];
  if (media?.original_title && media.original_title !== media.title) chips.push({ key: "original", label: t("tv.refine.original"), apply: () => setText(refineDefault(media.original_title, media.year)) });
  chips.push({ key: "no-year", label: t("tv.refine.no_year"), apply: () => setText(stripYear(text)) });
  if (ctx.kind === "series" && ctx.season !== null) {
    const code = `S${String(ctx.season).padStart(2, "0")}`;
    chips.push({ key: "season", label: t("tv.refine.season", { code }), apply: () => setText(withSeason(text, ctx.season!)) });
  }
  const btn = "tv-chip mb-5 flex h-[76px] items-center rounded-control bg-surface-2 px-8 text-[26px] font-bold";
  return (
    <div data-testid="refine" className="fixed left-0 top-0 z-30 h-[1080px] w-[1920px] bg-bg">
      {/* A focus boundary: the picker underneath stays unreachable. */}
      <FocusSection focusKey="refine" boundary className="absolute left-[120px] top-[80px] w-[1680px]">
        <p className="text-[24px] font-bold uppercase tracking-[.14em] text-accent">{ctx.title}</p>
        <h1 className="mt-3 text-[64px] font-bold">{t("tv.refine.title")}</h1>
        <p className="mt-3 text-[26px] text-muted">{t("tv.refine.hint")}</p>
        <div className="mt-10 flex h-[96px] items-center overflow-hidden rounded-card border-2 border-border bg-surface px-7" style={{ width: 1400 }}>
          <span data-testid="refine-text" className="whitespace-pre text-[40px] font-bold">
            {text.length > 52 ? `…${text.slice(-51)}` : text}
          </span>
          <span className="tv-caret ml-1 inline-block h-12 w-1 shrink-0 bg-accent" />
        </div>
        {error && <p className="mt-3 text-[24px] text-danger">{t("tv.refine.too_short")}</p>}
        <div className="mt-10 flex">
          <div style={{ width: KEYBOARD_WIDTH }}>
            <ScreenKeyboard focusKey="rkb" layout={layout} onLayout={setLayout} onAction={edit} />
          </div>
          <FocusSection focusKey="refine-side" className="ml-16 w-[560px]">
            {chips.map((c) => (
              <FocusButton key={c.key} focusKey={`refine-${c.key}`} onPress={c.apply} className={btn}>
                {c.label}
              </FocusButton>
            ))}
            <FocusButton focusKey="refine-loose" onPress={() => setLoose((v) => !v)} className={`${btn} justify-between`}>
              <span>{t("tv.refine.loose")}</span>
              <span data-testid="refine-loose" data-on={loose ? "1" : "0"} className={loose ? "text-accent" : "text-muted"}>
                {loose ? t("tv.settings.on") : t("tv.settings.off")}
              </span>
            </FocusButton>
            <FocusButton focusKey="refine-search" onPress={search} className="tv-chip flex h-[84px] items-center justify-center rounded-control bg-accent px-8 text-[30px] font-bold text-on-accent">
              ⌕ {t("tv.refine.search")}
            </FocusButton>
          </FocusSection>
        </div>
      </FocusSection>
    </div>
  );
}
