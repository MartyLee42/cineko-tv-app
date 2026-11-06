// «Онлайн · CDNVideoHub, Collaps» and «Аниме · AniLiberty» above the torrent results: online variants (voice,
// qualities, format, episodes) that play at once, here or on the TV. Shown
// only when a source has variants for this title, or quietly when one failed.
import { useMemo } from "react";
import type { Release } from "@martytv/contracts";
import { episodeRanges, groupProviders, onlineGroup, qualitiesLabel, variantHasEpisode, variantRelease } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import { AlertIcon, CastIcon, PlayIcon, StarIcon } from "../icons";
import { assessOnlineHere } from "./browserSupport";
import { BrowserBadge } from "./ReleaseList";
import type { ReleaseTarget } from "./releases";
import { useOnline, type OnlineVariant } from "./sourcesApi";

/** Variant → the Release the play flows take (id = variant id). */
export const asRelease = (v: OnlineVariant): Release => variantRelease(v);

export function OnlineGroup({
  target,
  profileId,
  here,
  currentId,
  onPick,
  onPickWith,
  onWatchHere,
}: {
  target: ReleaseTarget;
  profileId: string | undefined;
  /** "This browser" mode: the row watches here; the secondary action plays on the TV. */
  here: boolean;
  currentId?: string | null;
  onPick: (r: Release) => void;
  onPickWith?: (r: Release) => void;
  onWatchHere?: (r: Release) => void;
}) {
  const { t } = useI18n();
  const q = useOnline(target, profileId);
  // «Онлайн · CDNVideoHub, Collaps» first, then «Аниме · AniLiberty».
  const groups = useMemo(() => KINDS.map((kind) => ({ kind, ...onlineGroup(q.data, kind) })).filter((g) => g.show), [q.data]);
  if (q.isPending) {
    // Online lookups are quick; a quiet line instead of a skeleton (most titles have none).
    return (
      <p className="flex items-center gap-2 text-xs text-muted" data-testid="online-loading">
        <Spinner size={12} />
        {t("sources.group.loading")}
      </p>
    );
  }
  if (groups.length === 0) return null;
  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const names = groupProviders(group.items, group.failed);
        const kindLabel = t(group.kind === "anime" ? "sources.kind.anime" : "sources.kind.online");
        return (
          <section key={group.kind} className="space-y-2" data-testid="online-group" data-kind={group.kind} aria-label={`${kindLabel} · ${names.join(", ")}`}>
            <h3 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider">
              <span className="text-accent">{kindLabel}</span>
              <span className="text-muted">· {names.join(", ")}</span>
            </h3>
            {group.failed.length > 0 && (
              <p className="flex gap-1.5 text-xs text-muted" data-testid="online-failed">
                <AlertIcon className="mt-px shrink-0" />
                {t("sources.group.failed", { list: group.failed.map((p) => p.name).join(", ") })}
              </p>
            )}
            {group.items.length > 0 && (
              <ul className="space-y-2" data-testid="online-rows">
                {group.items.map((v) => {
                  const r = asRelease(v);
                  const available = variantHasEpisode(v, target.episode_number);
                  return (
                    <li key={v.id}>
                      <VariantRow
                        v={v}
                        available={available}
                        current={v.id === currentId}
                        here={here}
                        episode={target.episode_number}
                        onPick={() => (here && onWatchHere ? onWatchHere(r) : onPick(r))}
                        onSecondary={here ? () => onPick(r) : onPickWith && (() => onPickWith(r))}
                        onWatchHere={!here && onWatchHere ? () => onWatchHere(r) : undefined}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      <h3 className="pt-2 text-xs font-semibold uppercase tracking-wider text-muted">{t("sources.group.torrents")}</h3>
    </div>
  );
}

const KINDS = ["online", "anime"] as const;

function VariantRow({
  v,
  available,
  current,
  here,
  episode,
  onPick,
  onSecondary,
  onWatchHere,
}: {
  v: OnlineVariant;
  available: boolean;
  current: boolean;
  here: boolean;
  episode: number | undefined;
  onPick: () => void;
  onSecondary?: () => void;
  onWatchHere?: () => void;
}) {
  const { t } = useI18n();
  const support = here ? assessOnlineHere(v.format) : null;
  const eps =
    v.episode != null
      ? t("sources.variant.episode", { n: v.episode })
      : v.episodes.length > 0
        ? t("sources.variant.episodes", { list: episodeRanges(v.episodes) })
        : null;
  const disabled = current || !available;
  return (
    <div
      data-testid="online-row"
      data-variant-id={v.id}
      data-preferred={v.preferred ? "true" : undefined}
      className={`overflow-hidden rounded-2xl border transition focus-within:border-accent ${
        current ? "border-ok/50 bg-ok/5" : v.preferred ? "border-accent/60 bg-accent/[0.06] hover:border-accent" : "border-border bg-bg/40 hover:border-muted"
      } ${available ? "" : "opacity-60"}`}
    >
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        data-testid="online-pick"
        className="flex w-full items-center gap-3 p-3 text-left focus-visible:outline-none disabled:cursor-default"
      >
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg ${v.preferred ? "bg-accent text-on-accent" : "bg-surface-2 text-accent"}`}
          aria-hidden
        >
          {v.preferred ? <StarIcon /> : <PlayIcon className="translate-x-px" />}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-accent/15 px-1.5 text-sm font-semibold text-accent-strong" data-testid="online-voice">
              {v.voice}
            </span>
            {v.preferred && (
              <span className="text-[11px] font-bold uppercase tracking-wider text-accent">{t("sources.variant.preferred")}</span>
            )}
            {current && <span className="text-[11px] font-bold uppercase tracking-wider text-ok">{t("player.current_source")}</span>}
            {support && <BrowserBadge support={support} />}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
            {v.qualities.length > 0 && (
              <span className="font-semibold text-text/85" data-testid="online-qualities">
                {qualitiesLabel(v.qualities)}
              </span>
            )}
            <span className="rounded border border-border px-1 text-[10px] font-bold uppercase tracking-wide">{v.format}</span>
            {eps && <span data-testid="online-episodes">{eps}</span>}
            {v.title && <span className="truncate">{v.title}</span>}
          </span>
          {!available && episode != null && <span className="block text-xs text-danger">{t("sources.variant.no_episode", { n: episode })}</span>}
        </span>
        <span className="hidden shrink-0 text-right text-xs text-muted sm:block">{t("sources.variant.online")}</span>
      </button>
      {!disabled && (onSecondary || onWatchHere) && (
        <div className="flex justify-end gap-1 border-t border-border/70 px-1.5 py-1">
          {onWatchHere && (
            <button
              type="button"
              onClick={onWatchHere}
              data-testid="online-watch-here"
              className="mr-auto flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-accent hover:bg-surface-2"
            >
              <PlayIcon className="text-sm" />
              {t("player.web.watch_here")}
            </button>
          )}
          {onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              data-testid="online-secondary"
              className="flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-text/80 hover:bg-surface-2 hover:text-text"
            >
              <CastIcon className="text-base" />
              {here ? t("player.play_on_tv") : t("player.play_with")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
