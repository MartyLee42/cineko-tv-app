import { useState } from "react";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { imageUrl } from "@martytv/media-types";
import { Card, ErrorText, timeAgo } from "../components";
import { Img } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { useForYouQuality, useForYouWeights, useResetWeights, useSetAIFeature } from "../foryou/queries";
import {
  count,
  enough,
  funnelSteps,
  num,
  pct,
  QUALITY_WINDOWS,
  sourceRows,
  trend,
  type ProfileWeights,
  type QualityStats,
  type QualityWindow,
} from "../foryou/quality";

/** Admin → «Рекомендации»: the learned source weights per profile and the quality of the recommendations. */
export function ForYouLearnCard({ learnOn }: { learnOn: boolean }) {
  const { t } = useI18n();
  const [win, setWin] = useState<QualityWindow>("90");
  const weights = useForYouWeights();
  const quality = useForYouQuality(win);
  const setFeature = useSetAIFeature();
  const order = weights.data?.sources ?? [];
  const byProfile = new Map<string, ProfileWeights>((weights.data?.items ?? []).map((p) => [p.profile_id, p]));
  const profiles = new Map<string, { name: string; owner: string }>();
  for (const p of weights.data?.items ?? []) profiles.set(p.profile_id, { name: p.name, owner: p.owner });
  for (const p of quality.data?.profiles ?? []) profiles.set(p.profile_id, { name: p.name, owner: p.owner });
  const qBy = new Map((quality.data?.profiles ?? []).map((p) => [p.profile_id, p.stats]));

  return (
    <Card className="space-y-4">
      <div className="space-y-1" data-testid="foryou-learn">
        <h2 className="font-semibold">{t("quality.title")}</h2>
        <p className="text-xs text-muted">{t("quality.hint")}</p>
      </div>
      <div className="space-y-1 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={learnOn}
            disabled={setFeature.isPending}
            onChange={(e) => setFeature.mutate({ learn_weights: e.target.checked })}
            className="accent-[rgb(var(--mt-accent))]"
            data-testid="foryou-learn-weights"
          />
          {t("learnw.switch")}
        </label>
        <p className="text-xs text-muted">{t("learnw.switch_hint")}</p>
        <ErrorText error={setFeature.error} />
      </div>
      <div role="radiogroup" aria-label={t("quality.title")} className="inline-flex rounded-full border border-border bg-bg p-1">
        {QUALITY_WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={win === w}
            data-window={w}
            onClick={() => setWin(w)}
            className={`min-h-[36px] rounded-full px-4 text-sm font-medium transition ${win === w ? "bg-accent text-on-accent" : "text-muted hover:text-text"}`}
          >
            {t(`quality.window_${w}` as MessageKey)}
          </button>
        ))}
      </div>
      <ErrorText error={weights.error ?? quality.error} />
      {weights.isPending || quality.isPending ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : (
        <>
          {quality.data && (
            <section className="space-y-2" data-testid="foryou-quality-household">
              <h3 className="text-sm font-semibold">{t("quality.household")}</h3>
              <StatsView stats={quality.data.household} />
            </section>
          )}
          {profiles.size === 0 && <p className="text-sm text-muted">{t("learnw.empty")}</p>}
          {[...profiles].map(([id, p]) => (
            <ProfileView key={id} id={id} name={p.name} owner={p.owner} weights={byProfile.get(id)} stats={qBy.get(id)} order={order} />
          ))}
          <p className="text-xs text-muted">{t("learnw.window_note")}</p>
        </>
      )}
    </Card>
  );
}

function ProfileView({
  id,
  name,
  owner,
  weights,
  stats,
  order,
}: {
  id: string;
  name: string;
  owner: string;
  weights: ProfileWeights | undefined;
  stats: QualityStats | undefined;
  order: string[];
}) {
  const { t, locale } = useI18n();
  const reset = useResetWeights();
  const rows = sourceRows(order, weights?.items, stats?.sources);
  return (
    <details className="rounded-xl border border-border px-3 py-2" data-testid="foryou-learn-profile" data-profile={id}>
      <summary className="cursor-pointer text-sm">
        <span className="font-semibold">{name}</span>
        <span className="text-muted"> · {owner}</span>
        {weights && <span className="text-xs text-muted"> · {t("learnw.updated", { time: timeAgo(weights.updated_at, locale) })}</span>}
      </summary>
      <div className="mt-3 space-y-3">
        {stats && <StatsView stats={stats} />}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm tabular-nums" data-testid="foryou-weights-table">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1 pr-2 font-medium">{t("learnw.col_source")}</th>
                  <th className="px-2 py-1 text-right font-medium">{t("learnw.col_shown")}</th>
                  <th className="px-2 py-1 text-right font-medium">{t("learnw.col_opens")}</th>
                  <th className="px-2 py-1 text-right font-medium">{t("learnw.col_plays")}</th>
                  <th className="px-2 py-1 text-right font-medium">{t("learnw.col_avg")}</th>
                  <th className="px-2 py-1 text-right font-medium">{t("learnw.col_liked")}</th>
                  <th className="py-1 pl-2 text-right font-medium">{t("learnw.col_weight")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const tr = r.weight ? trend(r.weight) : "same";
                  return (
                    <tr key={r.source} data-source={r.source}>
                      <td className="py-1 pr-2">{t(`learnw.src.${r.source}` as MessageKey)}</td>
                      <td className="px-2 py-1 text-right">{count(r.shown, locale)}</td>
                      <td className="px-2 py-1 text-right">{count(r.opens, locale)}</td>
                      <td className="px-2 py-1 text-right">{count(r.plays, locale)}</td>
                      <td className="px-2 py-1 text-right">{num(r.avg, locale)}</td>
                      <td className="px-2 py-1 text-right">{pct(r.liked, locale)}</td>
                      <td
                        className={`py-1 pl-2 text-right font-semibold ${tr === "up" ? "text-ok" : tr === "down" ? "text-warn" : ""}`}
                        title={r.weight ? t("learnw.was", { v: num(r.weight.prev_weight, locale, 2) }) : undefined}
                        data-testid="foryou-weight"
                      >
                        {r.weight ? `${tr === "up" ? "↑ " : tr === "down" ? "↓ " : ""}${num(r.weight.weight, locale, 2)}×` : "1×"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {weights && (
          <button
            type="button"
            className="text-sm text-danger underline-offset-2 hover:underline"
            disabled={reset.isPending}
            data-testid="foryou-weights-reset"
            onClick={() => {
              if (window.confirm(t("learnw.reset_confirm", { name }))) reset.mutate(id);
            }}
          >
            {t("learnw.reset")}
          </button>
        )}
        <ErrorText error={reset.error} />
      </div>
    </details>
  );
}

function StatsView({ stats }: { stats: QualityStats }) {
  const { t, locale } = useI18n();
  if (stats.funnel.shown === 0) return <p className="text-sm text-muted">{t("quality.none")}</p>;
  const ratingLine = (s: QualityStats["recommended"]) =>
    enough(s.n)
      ? t("quality.rating_line", { avg: num(s.avg, locale), liked: pct(s.liked, locale), disliked: pct(s.disliked, locale), n: s.n })
      : t("quality.few", { n: s.n });
  return (
    <div className="space-y-2 text-sm" data-testid="foryou-quality-stats">
      <ol className="flex flex-wrap gap-2" data-testid="foryou-quality-funnel">
        {funnelSteps(stats.funnel).map((s) => (
          <li key={s.key} className="rounded-lg bg-bg px-2.5 py-1.5" data-step={s.key}>
            <span className="block text-xs text-muted">{t(`quality.f.${s.key}` as MessageKey)}</span>
            <span className="font-semibold tabular-nums">{s.n.toLocaleString(locale)}</span>
            {s.key !== "shown" && <span className="text-xs text-muted"> · {pct(s.share, locale)}</span>}
          </li>
        ))}
      </ol>
      <p>
        <span className="font-medium">{t("quality.recommended")}:</span> {ratingLine(stats.recommended)}
      </p>
      <p className="text-muted">
        <span className="font-medium">{t("quality.elsewhere")}:</span> {ratingLine(stats.elsewhere)}
      </p>
      {stats.calibration.length > 0 && (
        <div>
          <p className="font-medium">{t("quality.calibration")}</p>
          <ul className="text-xs text-muted" data-testid="foryou-quality-calibration">
            {stats.calibration.map((b, i) => (
              <li key={i}>
                {t("quality.calib_row", { min: num(b.score_min, locale, 2), max: num(b.score_max, locale, 2), shown: b.shown, played: b.played })} ·{" "}
                {enough(b.n) ? t("quality.rating_line", { avg: num(b.avg, locale), liked: pct(b.liked, locale), disliked: pct(b.disliked, locale), n: b.n }) : t("quality.few", { n: b.n })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {stats.precision_shown > 0 && <p className="text-xs text-muted">{t("quality.precision", { liked: stats.precision_liked, shown: stats.precision_shown })}</p>}
      <TitleStrip label={t("quality.hits")} items={stats.hits} testid="foryou-quality-hits" />
      <TitleStrip label={t("quality.misses")} items={stats.misses} testid="foryou-quality-misses" />
    </div>
  );
}

function TitleStrip({ label, items, testid }: { label: string; items: QualityStats["hits"]; testid: string }) {
  const { data: cfg } = useCatalogConfig();
  if (items.length === 0) return null;
  return (
    <div>
      <p className="font-medium">{label}</p>
      <ul className="mt-1 flex flex-wrap gap-2" data-testid={testid}>
        {items.map((m) => (
          <li key={m.media_id} className="w-16 text-xs">
            <div className="relative h-24 w-16 overflow-hidden rounded-md bg-bg">
              <Img src={imageUrl(cfg, m.poster_path, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
              <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 font-semibold text-white">{m.rating}</span>
            </div>
            <span className="mt-0.5 line-clamp-2 block">{m.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
