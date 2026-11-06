// "Can't play this here": why, and what to do instead — another release that
// suits browsers, an app on this device (VLC, Android chooser, .m3u, link),
// or the TV.
import { useState, type ReactNode } from "react";
import type { PlaybackSource } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { AlertIcon, ChevronLeft, DeviceIcon, ListIcon, PlayIcon, SearchIcon, TvIcon, VolumeIcon } from "../icons";
import { LocalOptions } from "../play/PlayHere";
import { releaseSummary } from "../play/PlayOnTv";

export type FallbackMode = "unsupported" | "decode" | "network" | "silent" | "precheck" | "source" | "prepare";

export interface AnotherRelease {
  /** Still searching / ranking. */
  loading: boolean;
  /** Label of the release that would be tried ("1080p · WEB-DL · H.264 · 3.1 GB"). */
  label: string | null;
  go: (() => void) | null;
}

export function Fallback({
  mode,
  message,
  reasons,
  source,
  title,
  another,
  onTv,
  onChoose,
  onTryAnyway,
  onContinue,
  onBack,
  onCompat,
}: {
  mode: FallbackMode;
  message: string;
  reasons: string[];
  /** Ready source: enables "Open in VLC / other app". */
  source: PlaybackSource | null;
  title: string;
  another: AnotherRelease | null;
  onTv: (() => void) | null;
  /** Open the release list (with «Уточнить поиск»). */
  onChoose?: () => void;
  onTryAnyway?: () => void;
  /** Silent mode: keep watching without sound. */
  onContinue?: () => void;
  onBack: () => void;
  /** Switch to the compat stream (audio converted on the server). */
  onCompat?: () => void;
}) {
  const { t, locale } = useI18n();
  const [apps, setApps] = useState(false);
  const heading =
    mode === "silent"
      ? t("player.web.fallback.silent_title")
      : mode === "precheck"
        ? t("player.web.fallback.precheck_title")
        : mode === "source" || mode === "prepare"
          ? t("player.web.fallback.prepare_title")
          : t("player.web.fallback.title");

  return (
    <div
      className="fixed inset-0 z-30 overflow-y-auto bg-bg text-text"
      data-testid="player-fallback"
      data-mode={mode}
      role="alertdialog"
      aria-labelledby="fallback-title"
    >
      <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-[max(env(safe-area-inset-left),1rem)] pb-[max(env(safe-area-inset-bottom),1.25rem)] pt-[max(env(safe-area-inset-top),0.5rem)]">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-2xl text-muted hover:text-text"
          aria-label={t("player.web.back")}
          data-testid="fallback-back"
        >
          <ChevronLeft />
        </button>
        <div className="my-auto space-y-5 py-4">
          <div className="space-y-3">
            <span
              className={`flex h-12 w-12 items-center justify-center rounded-2xl text-2xl ${
                mode === "silent" ? "bg-accent/15 text-accent" : "bg-danger/15 text-danger"
              }`}
            >
              {mode === "silent" ? <VolumeIcon /> : <AlertIcon />}
            </span>
            <div>
              <h1 id="fallback-title" className="font-display text-2xl font-extrabold leading-tight">
                {heading}
              </h1>
              <p className="mt-1 truncate text-sm text-muted">{title}</p>
            </div>
            <p className="text-base leading-relaxed" data-testid="fallback-message">
              {message}
            </p>
            {reasons.length > 0 && (
              <ul className="space-y-1.5 rounded-2xl border border-border bg-surface p-3 text-sm" data-testid="fallback-reasons">
                {reasons.map((r) => (
                  <li key={r} className="flex gap-2">
                    <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2.5">
            {onCompat && (
              <Action
                primary
                testId="fallback-compat"
                onClick={onCompat}
                icon={<VolumeIcon />}
                label={t("player.web.fallback.compat")}
                hint={t("player.web.fallback.compat_hint")}
              />
            )}
            {another && (another.loading || another.go) && (
              <Action
                primary={!onCompat}
                testId="fallback-another"
                onClick={another.go ?? undefined}
                disabled={!another.go}
                icon={another.loading ? <Spinner size={18} /> : <ListIcon />}
                label={t("player.web.fallback.another")}
                hint={another.loading ? t("player.web.fallback.finding") : another.label}
              />
            )}
            {another && !another.loading && !another.go && (
              <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" data-testid="fallback-no-another">
                {t("player.web.fallback.no_another")}
              </p>
            )}
            {onChoose && (
              <Action testId="fallback-choose" onClick={onChoose} icon={<SearchIcon />} label={t("player.refine.cta")} hint={t("player.web.fallback.choose_hint")} />
            )}
            {source?.stream_url && (
              <div className="rounded-2xl border border-border bg-surface">
                <Action
                  testId="fallback-apps"
                  onClick={() => setApps((a) => !a)}
                  icon={<DeviceIcon />}
                  label={t("player.web.fallback.apps")}
                  hint={t("player.web.fallback.apps_hint")}
                  expanded={apps}
                  flat
                />
                {apps && (
                  <div className="border-t border-border p-3">
                    <LocalOptions source={source} title={title} />
                  </div>
                )}
              </div>
            )}
            {onTv && <Action testId="fallback-tv" onClick={onTv} icon={<TvIcon />} label={t("player.play_on_tv")} hint={t("player.web.fallback.tv_hint")} />}
            {onContinue && (
              <Action testId="fallback-continue" onClick={onContinue} icon={<PlayIcon />} label={t("player.web.fallback.continue_silent")} />
            )}
            {onTryAnyway && (
              <Action testId="fallback-try" onClick={onTryAnyway} icon={<PlayIcon />} label={t("player.web.fallback.try_anyway")} />
            )}
          </div>
          {source && <p className="text-xs text-muted">{releaseSummary(source.release, locale)}</p>}
        </div>
      </div>
    </div>
  );
}

function Action({
  label,
  hint,
  icon,
  onClick,
  primary,
  disabled,
  testId,
  expanded,
  flat,
}: {
  label: string;
  hint?: string | null;
  icon: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  testId?: string;
  expanded?: boolean;
  flat?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      data-testid={testId}
      className={`flex min-h-[56px] w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-left transition disabled:opacity-70 ${
        primary
          ? "bg-accent text-on-accent hover:bg-accent-strong"
          : flat
            ? "hover:bg-surface-2"
            : "border border-border bg-surface hover:border-accent"
      }`}
    >
      <span className={`shrink-0 text-xl ${primary ? "" : "text-accent"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        {hint && <span className={`block truncate text-xs ${primary ? "text-on-accent/75" : "text-muted"}`}>{hint}</span>}
      </span>
    </button>
  );
}
