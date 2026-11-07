import { useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import type { MediaSummary } from "@martytv/contracts";
import { AI_CREATIVITY, Mascot, readAICreativity, useI18n, writeAICreativity, type AICreativity, type MessageKey } from "@martytv/ui";
import { FocusButton, FocusLine, FocusSection, setFocus, useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import { applyKey, physicalKey, type KeyAction, type Layout } from "../../catalog/keyboard";
import type { RouteMemory } from "../../catalog/nav";
import { useCatalogConfig } from "../../catalog/queries";
import { HRow } from "../../components/HRow";
import { KEYBOARD_WIDTH, ScreenKeyboard } from "../../components/ScreenKeyboard";
import { useDesign, useDevice, useFrame, type Design } from "../../design/context";
import { GridCard, gridGeo, ScreenTitle } from "../../design/grid";
import { TERMINAL_MENU } from "../../design/menuOrder";
import { useToTop } from "../../design/topJump";
import { playerKey } from "../../player/keys";
import { claimKeys } from "../../remote/keyOwner";
import { track } from "../../foryou/queries";
import { cycle } from "../../foryou/layout";
import {
  ASK_EXAMPLES,
  askErrorKind,
  askErrorText,
  askInbox,
  askValid,
  displayUrl,
  exampleLabel,
  examplePrompt,
  phoneAskUrl,
  sentenceCase,
  tailText,
  useAsk,
  useAsks,
  type AskKind,
  type AskResult,
} from "../../foryou/ask";
import { Emoji } from "../../design/Emoji";

const EDGE = 40;
const TILE = { w: 390, h: 150, gap: 24 };
const KINDS: AskKind[] = ["any", "movie", "series"];
const KIND_LABEL: Record<AskKind, MessageKey> = { any: "ask.kind.any", movie: "ask.kind.movie", series: "ask.kind.series" };

type Overlay = "keyboard" | "phone" | null;

/**
 * «Спросить ИИ»: big example tiles (OK sends at once), the on-screen
 * keyboard for an own question, or a QR to ask from the phone (the answer
 * arrives as `foryou.ask`). The answer: text, a poster row with «почему» of
 * the focused title, follow-up chips that ask again.
 */
export function AskScreen({ mem, profileId, onOpen }: { mem: RouteMemory; profileId: string; onOpen: (item: MediaSummary, from?: string) => void }) {
  const { t } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const ask = useAsk();
  const history = useAsks();
  const [kind, setKind] = useState<AskKind>(() => mem.get<AskKind>("kind") ?? "any");
  // An answer asked from the phone while this screen was closed comes first.
  const [boot] = useState(() => {
    const r = askInbox.take();
    if (r) {
      mem.set("result", r);
      mem.set("phone", true);
    }
    return { result: r ?? mem.get<AskResult>("result") ?? null, phone: r ? true : (mem.get<boolean>("phone") ?? false) };
  });
  const [result, setResult] = useState<AskResult | null>(boot.result);
  const [fromPhone, setFromPhone] = useState(boot.phone);
  const [prompt, setPrompt] = useState(() => mem.get<string>("prompt") ?? "");
  const [overlay, setOverlay] = useState<Overlay>(null);

  const show = (r: AskResult, phone = false) => {
    if (!ask.isPending) ask.reset();
    setResult(r);
    mem.set("result", r);
    setFromPhone(phone);
    mem.set("phone", phone);
    setOverlay(null);
    setTimeout(() => setFocus(r.items.length > 0 ? cardKey("a-card", r.items[0]!.media.id) : "a-chips"), 0);
  };
  // Answers asked from the phone.
  useEffect(() => askInbox.subscribe((r) => show(r, true)));

  const send = (text: string, k: AskKind = kind) => {
    const p = text.trim();
    if (!askValid(p)) return;
    setPrompt(p);
    mem.set("prompt", p);
    setOverlay(null);
    setResult(null);
    mem.set("result", null);
    ask.mutate({ profile_id: profileId, prompt: p, kind: k }, { onSuccess: (r) => show(r) });
  };
  const reset = () => {
    ask.reset();
    setResult(null);
    mem.set("result", null);
    setTimeout(() => setFocus(cardKey("a-tile", ASK_EXAMPLES[0].id)), 0);
  };
  const toggleKind = () => {
    const next = cycle(KINDS, kind);
    setKind(next);
    mem.set("kind", next);
  };
  // «Точнее / Обычно / Смелее»: this TV's nudge on the admin's AI temperature.
  const [creativity, setCreativity] = useState<AICreativity>(readAICreativity);
  const toggleCreativity = () => {
    const next = cycle(AI_CREATIVITY, creativity);
    setCreativity(next);
    writeAICreativity(next);
  };

  useInitialFocus(true, mem, () => (result ? (result.items.length ? cardKey("a-card", result.items[0]!.media.id) : "a-chips") : cardKey("a-tile", ASK_EXAMPLES[0].id)));
  useToTop(() => false);

  let body: ReactNode;
  if (ask.isPending) body = <Thinking prompt={prompt} design={design} />;
  else if (ask.isError) body = <AskError error={ask.error} design={design} onRetry={() => send(prompt)} onNew={reset} />;
  else if (result)
    body = (
      <Answer
        result={result}
        fromPhone={fromPhone}
        design={design}
        width={1920 - frame.x - 60}
        onOpen={(m) => {
          track(m.id, "open", "ask");
          onOpen(m, t("nav.ask"));
        }}
        onFollowup={(f) => send(f, (result.kind as AskKind) ?? kind)}
        onNew={reset}
      />
    );
  else
    body = (
      <FocusLine focusKey="a-form" keys={["a-tiles", "a-extra", "a-history"]} preferred="a-tiles">
        <FocusSection focusKey="a-tiles" className="flex flex-wrap" style={{ width: 4 * TILE.w + 3 * TILE.gap }}>
          {ASK_EXAMPLES.map((e, i) => (
            <Tile key={e.id} k={cardKey("a-tile", e.id)} design={design} last={i % 4 === 3} emoji={e.emoji} label={t(exampleLabel(e))} onPress={() => send(t(examplePrompt(e)), "any")} />
          ))}
          <Tile k={cardKey("a-tile", "type")} design={design} emoji="⌨" label={t("ask.tv.type")} accent onPress={() => setOverlay("keyboard")} />
          <Tile k={cardKey("a-tile", "phone")} design={design} last emoji="📱" label={t("ask.tv.phone")} onPress={() => setOverlay("phone")} />
        </FocusSection>
        <FocusSection focusKey="a-extra" className="mt-4 flex">
          <FocusButton focusKey="a-kind" onPress={toggleKind} className={`tv-chip bg-surface-2 px-7 py-3 ${design === "terminal" ? "" : "rounded-control"}`}>
            <span className={`block text-[19px] text-muted ${design === "terminal" ? "t-label" : ""}`}>{t("ask.kind")}</span>
            <span data-testid="ask-kind" className="mt-1 block text-[28px] font-bold">
              {t(KIND_LABEL[kind])}
            </span>
          </FocusButton>
          <FocusButton focusKey="a-creativity" onPress={toggleCreativity} className={`tv-chip ml-4 bg-surface-2 px-7 py-3 ${design === "terminal" ? "" : "rounded-control"}`}>
            <span className={`block text-[19px] text-muted ${design === "terminal" ? "t-label" : ""}`}>{t("ai.creativity")}</span>
            <span data-testid="ask-creativity" data-creativity={creativity} className="mt-1 block text-[28px] font-bold">
              {t(`ai.creativity.${creativity}` as MessageKey)}
            </span>
          </FocusButton>
        </FocusSection>
        <History items={history.data?.items ?? []} design={design} onPick={(r) => show(r)} />
      </FocusLine>
    );

  return (
    <div data-testid="ask" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <div className="absolute right-0 top-0" style={{ left: EDGE }}>
        <div className="flex h-[124px] items-end pb-5">
          <ScreenTitle design={design} index={TERMINAL_MENU.indexOf("ask") + 1}>
            {t("ask.title")}
          </ScreenTitle>
          {!result && !ask.isPending && !ask.isError && <span className="mb-2 ml-6 min-w-0 truncate text-[24px] text-muted">{t("ask.subtitle")}</span>}
        </div>
        <div className="pt-3">{body}</div>
      </div>
      {overlay === "keyboard" && <KeyboardOverlay initial="" kind={kind} onKind={toggleKind} onSend={(p) => send(p)} onClose={() => closeOverlay(setOverlay, "type")} />}
      {overlay === "phone" && <PhoneOverlay profileId={profileId} onClose={() => closeOverlay(setOverlay, "phone")} />}
    </div>
  );
}

function closeOverlay(set: (o: Overlay) => void, tile: string) {
  set(null);
  setTimeout(() => setFocus(cardKey("a-tile", tile)), 0);
}

function Tile({ k, emoji, label, onPress, design, last, accent }: { k: string; emoji: string; label: string; onPress: () => void; design: Design; last?: boolean; accent?: boolean }) {
  return (
    <div style={{ width: TILE.w, height: TILE.h, marginRight: last ? 0 : TILE.gap, marginBottom: TILE.gap }}>
      <FocusButton focusKey={k} onPress={onPress} className={`tv-chip flex h-full w-full items-center px-7 ${design === "terminal" ? "border border-border" : "rounded-card"} bg-surface-2 ${accent ? "border-2 border-accent" : ""}`}>
        <span className="mr-5 shrink-0 text-[52px] leading-none"><Emoji e={emoji} size={52} /></span>
        <span className={`line-clamp-2 min-w-0 text-[28px] font-bold leading-tight ${design === "terminal" ? "t-label text-[22px]" : ""}`}>{label}</span>
      </FocusButton>
    </div>
  );
}

function History({ items, design, onPick }: { items: AskResult[]; design: Design; onPick: (r: AskResult) => void }) {
  const { t } = useI18n();
  const recent = items.filter((r) => !r.refused && r.items.length > 0).slice(0, 4);
  if (recent.length === 0) return null;
  return (
    <div className="mt-8">
      <p className={`mb-3 text-[22px] text-muted ${design === "terminal" ? "t-label text-[18px]" : ""}`}>{t("ask.tv.history")}</p>
      <FocusSection focusKey="a-history" className="flex">
        {recent.map((r) => (
          <FocusButton key={r.id} focusKey={cardKey("a-hist", r.id)} onPress={() => onPick(r)} className={`tv-chip mr-4 w-[390px] bg-surface px-6 py-3 ${design === "terminal" ? "border border-border" : "rounded-control"}`}>
            <span className="block truncate text-[24px] font-semibold">{r.prompt}</span>
            <span className="mt-1 block text-[18px] text-muted">{t("ask.history_count", { count: r.items.length })}</span>
          </FocusButton>
        ))}
      </FocusSection>
    </div>
  );
}

/** Loading: the prompt bubble and a floating mascot with thinking dots. */
function Thinking({ prompt, design }: { prompt: string; design: Design }) {
  const { t } = useI18n();
  return (
    <div data-testid="ask-thinking">
      <Bubble design={design}>{prompt}</Bubble>
      <div className="mt-14 flex items-center">
        <span className="tv-loader-float flex h-[120px] w-[120px] items-center justify-center">
          <Mascot size={120} mood="thinking" />
        </span>
        <div className="ml-10">
          <p className="flex items-center text-[44px] font-bold">
            {t("ask.thinking")}
            <span className="ml-5 flex">
              {[1, 2, 3].map((i) => (
                <span key={i} className={`tv-dot tv-dot-${i} mr-3 inline-block h-[16px] w-[16px] rounded-full bg-accent`} />
              ))}
            </span>
          </p>
          <p className="mt-3 max-w-[1100px] text-[26px] text-muted">{t("ask.thinking_hint")}</p>
        </div>
      </div>
    </div>
  );
}

function Bubble({ design, label, children }: { design: Design; label?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className={`inline-block max-w-[1500px] bg-surface-2 px-7 py-4 ${design === "terminal" ? "border-l-4 border-accent" : "rounded-[28px] rounded-tl-[6px]"}`}>
      <span className={`mr-3 text-[22px] font-bold text-accent ${design === "terminal" ? "t-label" : ""}`}>{label ?? t("ask.you")}</span>
      <span data-testid="ask-prompt" className="text-[26px]">
        {children}
      </span>
    </div>
  );
}

function AskError({ error, design, onRetry, onNew }: { error: unknown; design: Design; onRetry: () => void; onNew: () => void }) {
  const { t } = useI18n();
  const kind = askErrorKind(error);
  const e = askErrorText[kind];
  const btn = `tv-chip mr-5 flex h-[84px] items-center px-12 text-[30px] font-bold ${design === "terminal" ? "t-label" : "rounded-full"}`;
  useEffect(() => {
    const id = setTimeout(() => setFocus(e.retry ? "a-retry" : "a-new"), 0);
    return () => clearTimeout(id);
  }, [e.retry]);
  return (
    <div data-testid="ask-error" data-kind={kind} className="max-w-[1300px]">
      {e.title && <p className="text-[52px] font-bold">{t(e.title)}</p>}
      <p className={`text-[32px] leading-snug ${e.title ? "mt-4 text-muted" : "text-text"}`}>{t(e.text)}</p>
      <FocusSection focusKey="a-err" className="mt-10 flex">
        {e.retry && (
          <FocusButton focusKey="a-retry" onPress={onRetry} className={`${btn} bg-accent text-on-accent`}>
            {t("ask.retry")}
          </FocusButton>
        )}
        <FocusButton focusKey="a-new" onPress={onNew} className={`${btn} bg-surface-2`}>
          {t("ask.new")}
        </FocusButton>
      </FocusSection>
    </div>
  );
}

/** The answer: text, «почему» of the focused title, the posters and follow-ups. */
function Answer({
  result,
  fromPhone,
  design,
  width,
  onOpen,
  onFollowup,
  onNew,
}: {
  result: AskResult;
  fromPhone: boolean;
  design: Design;
  width: number;
  onOpen: (m: MediaSummary) => void;
  onFollowup: (text: string) => void;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const cfg = useCatalogConfig();
  const [focus, setFocusIdx] = useState(0);
  const g = gridGeo(design, width);
  const cur = result.items[Math.min(focus, result.items.length - 1)];
  const square = design === "terminal";
  return (
    <div data-testid="ask-result" data-refused={result.refused ? "1" : "0"}>
      <Bubble design={design} label={fromPhone ? `📱 ${t("ask.tv.from_phone")}:` : undefined}>
        {tailText(result.prompt, 110)}
      </Bubble>
      <p data-testid="ask-answer" className="mt-5 line-clamp-2 max-w-[1560px] text-[30px] leading-snug">
        {result.answer}
      </p>
      {cur ? (
        <>
          <div data-testid="ask-why" className="mt-4 h-[96px] max-w-[1560px]">
            <p className={`truncate text-[34px] font-bold leading-tight ${square ? "font-display uppercase text-[30px]" : ""}`}>
              {cur.media.title}
              <span className="ml-4 text-[24px] font-normal text-muted">{[cur.media.year, t(`catalog.kind.${cur.media.kind}` as MessageKey)].filter(Boolean).join(" · ")}</span>
            </p>
            {cur.why && (
              <p className="mt-2 line-clamp-1 text-[26px] text-text/85">
                <span className={`mr-3 font-bold text-accent ${square ? "t-label text-[20px]" : ""}`}>{t("ask.why")}:</span>
                {cur.why}
              </p>
            )}
          </div>
          <HRow
            focusKey="a-cards"
            items={result.items}
            itemKey={(it) => cardKey("a-card", it.media.id)}
            itemWidth={g.w}
            itemHeight={g.pitchY - 30}
            gap={g.pitchX - g.w}
            viewport={width}
            onIndexChange={(i) => setFocusIdx(i)}
            onSelect={(it) => onOpen(it.media)}
            quick={(it) => ({ item: it.media, onOpen: () => onOpen(it.media) })}
            renderItem={(it, focused, i) => <GridCard item={it.media} cfg={cfg.data} g={g} focused={focused} index={i} />}
          />
        </>
      ) : (
        <p className="mt-6 text-[26px] text-muted">{result.refused ? "" : t("ask.empty_items")}</p>
      )}
      <FocusSection focusKey="a-chips" className="mt-3 flex">
        {result.followups.slice(0, 3).map((f, i) => (
          <FocusButton key={i} focusKey={`a-fu-${i}`} onPress={() => onFollowup(f)} className={`tv-chip mr-4 flex h-[68px] max-w-[520px] items-center bg-surface-2 px-7 text-[24px] font-semibold ${square ? "t-label text-[19px]" : "rounded-full"}`}>
            <span className="truncate">↻ {f}</span>
          </FocusButton>
        ))}
        <FocusButton focusKey="a-new" onPress={onNew} className={`tv-chip flex h-[68px] items-center bg-accent px-8 text-[24px] font-bold text-on-accent ${square ? "t-label text-[19px]" : "rounded-full"}`}>
          ✎ {t("ask.new")}
        </FocusButton>
      </FocusSection>
    </div>
  );
}

/** Own question: the on-screen keyboard (Back closes; a hardware keyboard types too). */
function KeyboardOverlay({ initial, kind, onKind, onSend, onClose }: { initial: string; kind: AskKind; onKind: () => void; onSend: (p: string) => void; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [text, setText] = useState(() => initial.toUpperCase());
  const [layout, setLayout] = useState<Layout>(locale === "en" ? "en" : "ru");
  const edit = (a: KeyAction) => setText((p) => applyKey(p, a));
  const close = useRef(onClose);
  const textRef = useRef(text);
  useEffect(() => {
    close.current = onClose;
    textRef.current = text;
  });
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
    void setFocus(layout === "ru" ? "akb-А" : "akb-A");
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shown = sentenceCase(text);
  const ok = askValid(shown);
  const btn = "tv-chip mb-5 flex h-[84px] items-center rounded-control px-8 text-[28px] font-bold";
  return (
    <div data-testid="ask-keyboard" className="fixed left-0 top-0 z-30 h-[1080px] w-[1920px] bg-bg">
      <FocusSection focusKey="ask-kb" boundary className="absolute left-[120px] top-[80px] w-[1680px]">
        <h1 className="text-[60px] font-bold">{t("ask.title")}</h1>
        <p className="mt-2 text-[26px] text-muted">{t("ask.tv.keyboard_hint")}</p>
        <div className="mt-8 flex h-[96px] items-center overflow-hidden rounded-card border-2 border-border bg-surface px-7" style={{ width: 1480 }}>
          <span data-testid="ask-text" className={`whitespace-pre text-[38px] font-bold ${shown ? "" : "text-muted"}`}>
            {shown ? tailText(shown, 60) : t("ask.placeholder").slice(0, 60)}
          </span>
          <span className="tv-caret ml-1 inline-block h-12 w-1 shrink-0 bg-accent" />
        </div>
        <div className="mt-10 flex">
          <div style={{ width: KEYBOARD_WIDTH }}>
            <ScreenKeyboard focusKey="akb" layout={layout} onLayout={setLayout} onAction={edit} />
          </div>
          <FocusSection focusKey="ask-kb-side" className="ml-16 w-[560px]">
            <FocusButton focusKey="akb-kind" onPress={onKind} className={`${btn} justify-between bg-surface-2`}>
              <span className="text-[24px] text-muted">{t("ask.kind")}</span>
              <span>{t(KIND_LABEL[kind])}</span>
            </FocusButton>
            <FocusButton focusKey="akb-send" onPress={() => ok && onSend(shown)} className={`${btn} justify-center ${ok ? "bg-accent text-on-accent" : "bg-surface-2 text-muted"}`}>
              {t("ask.send")}
            </FocusButton>
            <FocusButton focusKey="akb-close" onPress={onClose} className={`${btn} justify-center bg-surface-2`}>
              {t("ask.tv.close")}
            </FocusButton>
          </FocusSection>
        </div>
      </FocusSection>
    </div>
  );
}

/** «Спросить с телефона»: a QR of /ask?device=…; the answer arrives over realtime. */
function PhoneOverlay({ profileId, onClose }: { profileId: string; onClose: () => void }) {
  const { t } = useI18n();
  const device = useDevice();
  const url = device ? phoneAskUrl(location.origin, device.id, profileId) : "";
  const [qr, setQr] = useState<string | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!url) return;
    let live = true;
    QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" })
      .then((d) => live && setQr(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top || playerKey(e) !== "back") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    void setFocus("aph-close");
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, []);
  return (
    <div data-testid="ask-phone" className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] items-center justify-center bg-bg/95">
      <FocusSection focusKey="ask-phone" boundary className="flex items-center rounded-[40px] bg-surface p-16">
        <div className="flex h-[384px] w-[384px] shrink-0 items-center justify-center rounded-2xl bg-white p-3">{qr && <img data-testid="ask-qr" src={qr} alt="" width={360} height={360} />}</div>
        <div className="ml-16 w-[760px]">
          <h2 className="text-[54px] font-bold">{t("ask.tv.phone")}</h2>
          <p className="mt-5 text-[30px] leading-snug text-text/85">{t("ask.tv.phone_hint", { url: displayUrl(url) })}</p>
          <p className="mt-8 flex items-center text-[26px] text-muted">
            <span className="mr-4 flex">
              {[1, 2, 3].map((i) => (
                <span key={i} className={`tv-dot tv-dot-${i} mr-2 inline-block h-[12px] w-[12px] rounded-full bg-accent`} />
              ))}
            </span>
            {t("ask.tv.waiting")}
          </p>
          <div className="mt-10 flex">
            <FocusButton focusKey="aph-close" onPress={onClose} className="tv-chip flex h-[80px] items-center rounded-full bg-surface-2 px-12 text-[28px] font-bold">
              {t("ask.tv.close")}
            </FocusButton>
          </div>
        </div>
      </FocusSection>
    </div>
  );
}
