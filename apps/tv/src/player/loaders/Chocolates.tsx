// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useMemo } from "react";
import { catalogLang } from "@martytv/media-types";
import { useI18n, type MediaFacts } from "@martytv/ui";
import { factsKey } from "../../catalog/trivia";
import { CHOCOLATES, chocolateLines, chocolatesEaten, lineFor, runtimeLabel } from "../homage";
import type { LoaderModel } from "../loaderParts";
import { cached, HomageLayout, useCachedDetail } from "./homageParts";
import "./Chocolates.css";

const COLS = 4;
/** Kinds of chocolate, picked per slot: round dark, square milk, white heart-ish, striped. */
const KINDS = ["lc-dark", "lc-milk", "lc-white", "lc-stripe"] as const;

/**
 * «Коробка конфет»: a box of twelve; one goes every ~8 %, and each says
 * something about the title — its facts when they're already cached, else
 * lines from the cached Details (genre, year, director…). Never fetches.
 */
export default function Chocolates({ m }: { m: LoaderModel }) {
  const { t, locale } = useI18n();
  const lang = catalogLang(locale);
  const detail = useCachedDetail(m.seed);
  const facts = cached<MediaFacts>(factsKey(m.seed, lang));
  const lines = useMemo(() => {
    const fs = (facts?.items ?? []).filter((f) => !f.spoiler).map((f) => f.text);
    return chocolateLines(fs, detail, (min) => {
      const r = runtimeLabel(min);
      return r ? t(r.key, r.vars) : null;
    });
  }, [facts, detail, t]);
  const eaten = chocolatesEaten(m.p);
  const line = lineFor(lines, eaten, m.seed);
  const text = line ? ("text" in line ? line.text : t(line.key, { v: line.v })) : null;
  return (
    <HomageLayout m={m} name="chocolate_box" caption={t("loaders2.chocolate_box.caption")} backdrop={0.1}>
      <div className="lc-box absolute left-[180px] top-[70px] h-[480px] w-[760px] rounded-[28px]">
        <div className="lc-inner absolute left-[26px] top-[26px] h-[428px] w-[708px] rounded-[18px]">
          {Array.from({ length: CHOCOLATES }, (_, i) => {
            const gone = i < eaten;
            const next = i === eaten;
            const x = 24 + (i % COLS) * 168;
            const y = 18 + Math.floor(i / COLS) * 136;
            return (
              <div key={i} className="absolute" style={{ left: x, top: y, width: 156, height: 124 }}>
                <span className="lc-cup absolute left-[18px] top-[2px] block h-[120px] w-[120px] rounded-full" />
                <span
                  className={`lc-choc ${KINDS[(i * 7 + 3) % KINDS.length]} ${next ? "is-next" : ""} absolute left-[30px] top-[14px] block h-[96px] w-[96px]`}
                  style={{ opacity: gone ? 0 : 1, transform: gone ? "scale(.4) translate3d(0,-40px,0)" : undefined }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="lc-card absolute left-[1000px] top-[110px] w-[740px] rounded-[28px] px-12 py-10">
        <p className="text-3xl font-semibold uppercase tracking-wider text-accent">
          {t("loaders2.chocolate_box.count", { n: Math.max(1, eaten), total: CHOCOLATES })}
        </p>
        {/* Re-mount per chocolate: a short fade-in each time. */}
        <p key={eaten} data-testid="chocolate-fact" className="lc-fact mt-6 line-clamp-5 text-[40px] leading-snug">
          {eaten > 0 && text ? text : "…"}
        </p>
      </div>
    </HomageLayout>
  );
}
