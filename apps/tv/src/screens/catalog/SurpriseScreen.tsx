import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Genre, MediaSummary } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { EMPTY_SURPRISE, reasonText, Spinner, surpriseRequest, useI18n, type Mood, type MessageKey, type SurpriseForm, type SurpriseKind } from "@martytv/ui";
import { FocusButton, FocusLine, FocusSection, setFocus, useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { useCatalogConfig, useGenres } from "../../catalog/queries";
import { HRow } from "../../components/HRow";
import { Img, legacyColor } from "../../components/Img";
import { ErrorState } from "../../components/States";
import { useDesign, useFrame, type Design } from "../../design/context";
import { ScreenTitle } from "../../design/grid";
import { useToTop } from "../../design/topJump";
import { track, useSurprise, useSurpriseOptions, type MoodOption, type SurpriseResult } from "../../foryou/queries";
import { cycle } from "../../foryou/layout";
import { activeProfile } from "../../profile/active";
import { Emoji } from "../../design/Emoji";

const EDGE = 40;
const MOOD = { w: 230, h: 190 };
const KINDS: SurpriseKind[] = ["movie", "series", "any"];
const RATINGS: (number | null)[] = [null, 6, 7, 8];

type MoodTile = { key: Mood | null; title: string; emoji: string };

/**
 * «Удиви меня!»: a few remote-friendly toggles, mood tiles (OK on a mood =
 * surprise me in that mood) and a big spoiler-free reveal card.
 */
export function SurpriseScreen({ mem, onOpen, onWatch }: { mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void; onWatch: (item: MediaSummary) => void }) {
  const { t } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const options = useSurpriseOptions();
  const surprise = useSurprise();
  const [form, setForm] = useState<SurpriseForm>(() => mem.get<SurpriseForm>("form") ?? EMPTY_SURPRISE);
  const [spoilerFree, setSpoilerFree] = useState(() => mem.get<boolean>("spoiler") ?? true);
  const [result, setResult] = useState<SurpriseResult | null>(() => mem.get<SurpriseResult>("result") ?? null);
  const [revealed, setRevealed] = useState(() => mem.get<boolean>("revealed") ?? false);
  const [exclude, setExclude] = useState<string[]>(() => mem.get<string[]>("exclude") ?? []);

  const update = (patch: Partial<SurpriseForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    mem.set("form", next);
  };
  const decades = [null, ...(options.data?.decades ?? [])];
  const moods: MoodTile[] = [
    { key: null, title: t("fy.surprise.any"), emoji: "🎲" },
    ...(options.data?.moods ?? []).map((m: MoodOption) => ({ key: m.key, title: m.title, emoji: m.emoji })),
  ];

  const run = (f: SurpriseForm, ex: string[]) => {
    surprise.mutate(surpriseRequest(f, activeProfile.get() ?? "", ex), {
      onSuccess: (r) => {
        setResult(r);
        mem.set("result", r);
        const rev = !spoilerFree;
        setRevealed(rev);
        mem.set("revealed", rev);
        setExclude(r.reroll.exclude_ids);
        mem.set("exclude", r.reroll.exclude_ids);
        setTimeout(() => setFocus(r.media ? (rev ? "s-watch" : "s-reveal") : "s-filters"), 0);
      },
    });
  };
  const go = (mood?: Mood | null) => {
    const f = mood === undefined ? form : { ...form, mood };
    if (mood !== undefined) update({ mood });
    setExclude([]);
    run(f, []);
  };
  const reroll = () => run(form, exclude);
  const reveal = () => {
    setRevealed(true);
    mem.set("revealed", true);
    setTimeout(() => setFocus("s-watch"), 0);
  };
  const backToForm = () => {
    setResult(null);
    mem.set("result", null);
    setTimeout(() => setFocus(cardKey("s-mood", form.mood ?? "any")), 0);
  };

  useInitialFocus(!options.isPending, mem, () => (result ? (result.media ? (revealed ? "s-watch" : "s-reveal") : "s-filters") : options.isError ? "s-retry" : cardKey("s-mood", form.mood ?? "any")));
  useToTop(() => false);

  let body: ReactNode;
  if (options.isError) body = <ErrorState focusKey="s-retry" error={options.error} onRetry={() => void options.refetch()} />;
  else if (result)
    body = (
      <Reveal
        result={result}
        revealed={revealed}
        busy={surprise.isPending}
        design={design}
        onReveal={reveal}
        onReroll={reroll}
        onFilters={backToForm}
        onWatch={(m) => {
          track(m.id, "play", "surprise");
          onWatch(m);
        }}
        onDetails={(m) => {
          track(m.id, "open", "surprise");
          onOpen(m, t("nav.surprise"));
        }}
      />
    );
  else
    body = (
      <FocusLine focusKey="s-form" keys={["s-toggles", "s-moods", "s-go"]} preferred="s-moods">
        <FocusSection focusKey="s-toggles" className="flex">
          <Toggle k="s-kind" design={design} label={t("fy.surprise.kind")} value={t(`fy.surprise.kind_${form.kind}` as MessageKey)} onPress={() => update({ kind: cycle(KINDS, form.kind) })} />
          <Toggle
            k="s-decade"
            design={design}
            label={t("fy.surprise.decade")}
            value={form.decade ? t("fy.surprise.decade_label", { decade: form.decade }) : t("fy.surprise.any")}
            onPress={() => update({ decade: cycle(decades, form.decade) })}
          />
          <Toggle
            k="s-rating"
            design={design}
            label={t("fy.surprise.min_rating")}
            value={form.minRating ? `${form.minRating}+` : t("fy.surprise.any")}
            onPress={() => update({ minRating: cycle(RATINGS, form.minRating) })}
          />
          <Toggle k="s-watched" design={design} label={t("fy.surprise.include_watched")} value={form.includeWatched ? "✓" : "—"} onPress={() => update({ includeWatched: !form.includeWatched })} />
          <Toggle
            k="s-spoiler"
            design={design}
            label={t("fy.surprise.spoiler_free")}
            value={spoilerFree ? "✓" : "—"}
            onPress={() => {
              setSpoilerFree(!spoilerFree);
              mem.set("spoiler", !spoilerFree);
            }}
          />
        </FocusSection>
        <p className="mb-2 mt-10 text-[26px] text-muted">{t("fy.tv.surprise_hint")}</p>
        <HRow
          focusKey="s-moods"
          items={moods}
          itemKey={(m) => cardKey("s-mood", m.key ?? "any")}
          itemWidth={MOOD.w}
          itemHeight={MOOD.h}
          gap={22}
          viewport={1920 - frame.x - 60}
          initialIndex={Math.max(0, moods.findIndex((m) => m.key === form.mood))}
          onSelect={(m) => go(m.key)}
          renderItem={(m, focused) => <MoodCard m={m} focused={focused} selected={m.key === form.mood} design={design} />}
        />
        <div className="mt-8 flex">
          <FocusButton focusKey="s-go" onPress={() => go()} className={`flex h-[96px] items-center px-16 text-[38px] font-bold bg-accent text-on-accent ${design === "terminal" ? "t-label" : "rounded-full"}`}>
            {surprise.isPending ? <Spinner size={40} /> : <><Emoji e="🎲" size={36} />&nbsp;&nbsp;{t("fy.surprise.go")}</>}
          </FocusButton>
        </div>
      </FocusLine>
    );

  return (
    <div data-testid="surprise" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <div className="absolute right-0 top-0" style={{ left: EDGE }}>
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design} index={6}>
            {t("fy.surprise.title")}
          </ScreenTitle>
          {!result && <span className="mb-2 ml-6 text-[24px] text-muted">{t("fy.surprise.subtitle")}</span>}
        </div>
        <div className="pt-4">{body}</div>
      </div>
    </div>
  );
}

function Toggle({ k, label, value, onPress, design }: { k: string; label: string; value: string; onPress: () => void; design: Design }) {
  return (
    <FocusButton focusKey={k} onPress={onPress} className={`tv-chip mr-4 bg-surface-2 px-7 py-4 ${design === "terminal" ? "" : "rounded-control"}`}>
      <span className={`block text-[19px] text-muted ${design === "terminal" ? "t-label" : ""}`}>{label}</span>
      <span className="mt-1 block text-[28px] font-bold">{value}</span>
    </FocusButton>
  );
}

function MoodCard({ m, focused, selected, design }: { m: MoodTile; focused: boolean; selected: boolean; design: Design }) {
  return (
    <div
      data-mood={m.key ?? "any"}
      className={`tv-focus flex flex-col items-center justify-center ${design === "terminal" ? "" : "rounded-card"} ${focused ? "is-focused" : ""} ${selected ? "bg-accent text-on-accent" : "bg-surface-2"}`}
      style={{ width: MOOD.w, height: MOOD.h }}
    >
      <span className="text-[64px] leading-none"><Emoji e={m.emoji} size={64} /></span>
      <span className={`mt-4 block max-w-full truncate px-3 text-[25px] font-semibold ${design === "terminal" ? "t-label text-[20px]" : ""}`}>{m.title}</span>
    </div>
  );
}

/** The pick: genres, year and why first; poster and title once revealed. */
function Reveal({
  result,
  revealed,
  busy,
  design,
  onReveal,
  onReroll,
  onFilters,
  onWatch,
  onDetails,
}: {
  result: SurpriseResult;
  revealed: boolean;
  busy: boolean;
  design: Design;
  onReveal: () => void;
  onReroll: () => void;
  onFilters: () => void;
  onWatch: (m: MediaSummary) => void;
  onDetails: (m: MediaSummary) => void;
}) {
  const { t } = useI18n();
  const cfg = useCatalogConfig();
  const movieGenres = useGenres("movie");
  const seriesGenres = useGenres("series");
  const names = useMemo(() => {
    const all = new Map<number, string>();
    for (const g of [...(movieGenres.data ?? []), ...(seriesGenres.data ?? [])] as Genre[]) all.set(g.id, g.name);
    return all;
  }, [movieGenres.data, seriesGenres.data]);
  const m = result.media;
  const [shown, setShown] = useState(revealed);
  // A frame later, so the poster fades in (opacity transition).
  useEffect(() => {
    const id = setTimeout(() => setShown(revealed), 30);
    return () => clearTimeout(id);
  }, [revealed]);
  const btn = `flex h-[84px] items-center px-12 text-[30px] font-bold ${design === "terminal" ? "t-label" : "rounded-full"}`;
  if (!m) {
    return (
      <div data-testid="surprise-none">
        <p className="max-w-[1200px] text-[34px] leading-snug text-muted">{t("fy.surprise.none")}</p>
        <div className="mt-10 flex">
          <FocusButton focusKey="s-filters" onPress={onFilters} className={`${btn} bg-surface-2`}>
            {t("fy.surprise.filters")}
          </FocusButton>
        </div>
      </div>
    );
  }
  const genres = m.genre_ids.map((id) => names.get(id)).filter(Boolean).slice(0, 3).join(", ");
  const reason = result.reason ? reasonText(result.reason, t) : null;
  const square = design === "terminal";
  return (
    <div data-testid="surprise-result" data-revealed={revealed ? "1" : "0"} className="flex">
      <div className={`relative shrink-0 overflow-hidden ${square ? "" : "rounded-card"}`} style={{ width: 400, height: 600, background: legacyColor(placeholderColor(revealed ? m.id : "mystery")) }}>
        <div className={`absolute left-0 top-0 flex h-full w-full items-center justify-center transition-opacity duration-500 ${shown ? "opacity-0" : "opacity-100"}`}>
          <span className="text-[180px] font-bold leading-none text-white/80">?</span>
        </div>
        {revealed && (
          <div className={`absolute left-0 top-0 h-full w-full transition-opacity duration-700 ${shown ? "opacity-100" : "opacity-0"}`}>
            <Img src={imageUrl(cfg.data, m.poster_path, "w500")} className="absolute left-0 top-0 h-full w-full object-cover" />
          </div>
        )}
      </div>
      <div className="ml-16 min-w-0 flex-1 pt-4">
        <p className={`text-[24px] font-bold text-accent ${square ? "t-label" : "uppercase tracking-[.14em]"}`}>
          {[t(`catalog.kind.${m.kind}` as MessageKey), m.year ? String(m.year) : null, genres || null].filter(Boolean).join("  ·  ")}
        </p>
        <h2 data-testid="surprise-title" className={`mt-5 line-clamp-2 text-[76px] font-bold leading-[1.05] ${square ? "font-display uppercase" : ""} ${revealed ? "" : "text-text/40"}`}>
          {revealed ? m.title : t("fy.surprise.mystery")}
        </h2>
        {reason && <p className="mt-6 max-w-[1100px] text-[30px] leading-snug text-text/85">{reason}</p>}
        {revealed && m.overview && <p className="mt-5 line-clamp-3 max-w-[1100px] text-[24px] leading-snug text-text/65">{m.overview}</p>}
        <p className="mt-5 text-[22px] text-muted">
          {t("fy.surprise.pool", { n: result.pool_size })}
          {result.source === "discover" ? `  ·  ${t("fy.surprise.from_discover")}` : ""}
        </p>
        <FocusSection focusKey="s-actions" className="mt-10 flex">
          {!revealed && (
            <FocusButton focusKey="s-reveal" onPress={onReveal} className={`${btn} mr-5 bg-accent text-on-accent`}>
              {t("fy.surprise.reveal")}
            </FocusButton>
          )}
          <FocusButton focusKey="s-watch" onPress={() => onWatch(m)} className={`${btn} mr-5 ${revealed ? "bg-accent text-on-accent" : "bg-surface-2"}`}>
            ▶&nbsp;&nbsp;{t("fy.surprise.watch")}
          </FocusButton>
          <FocusButton focusKey="s-reroll" onPress={onReroll} className={`${btn} mr-5 bg-surface-2`}>
            {busy ? <Spinner size={36} /> : <><Emoji e="🎲" size={34} />&nbsp;&nbsp;{t("fy.surprise.reroll")}</>}
          </FocusButton>
          {revealed && (
            <FocusButton focusKey="s-details" onPress={() => onDetails(m)} className={`${btn} mr-5 bg-surface-2`}>
              {t("fy.surprise.details")}
            </FocusButton>
          )}
          <FocusButton focusKey="s-filters" onPress={onFilters} className={`${btn} bg-surface-2`}>
            {t("fy.surprise.filters")}
          </FocusButton>
        </FocusSection>
      </div>
    </div>
  );
}
