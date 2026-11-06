import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { PlaybackSource, Release } from "@martytv/contracts";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Button } from "../components";
import { AlertIcon, CheckIcon, CopyIcon, DownloadIcon, PlayIcon } from "../icons";
import { watchUrl } from "../player/logic";
import { assessSource, compatUsable, thisBrowser, verdictLabel, withCompat } from "./browserSupport";
import { Sheet } from "../remote/SendToTv";
import { apiErrorCode, createSource } from "./queries";
import { releaseSummary, useSourceStatus, type PlayTarget } from "./PlayOnTv";
import {
  absoluteStreamUrl,
  detectPlatform,
  intentUrl,
  m3u,
  orderLocalOptions,
  readLocalDefault,
  safeName,
  streamFileName,
  vlcUrl,
  type LocalPlayer,
} from "./players";
import { sourceErrorMessage } from "./releases";

const LABEL: Record<LocalPlayer, MessageKey> = {
  vlc: "player.local.vlc",
  intent: "player.local.intent",
  m3u: "player.local.m3u",
  copy: "player.local.copy",
};

/**
 * "On this device": prepares the release and offers apps on this phone /
 * computer that can play the stream (VLC, Android chooser, M3U, link).
 */
export function PlayHereSheet({ target, release, onClose }: { target: PlayTarget; release: Release; onClose: () => void }) {
  const { t, locale } = useI18n();
  const created = useQuery({
    queryKey: ["here-source", target.media_id, release.id, target.episode_id ?? null],
    queryFn: () =>
      createSource({ media_id: target.media_id, release_id: release.id, ...(target.episode_id && { episode_id: target.episode_id }) }),
    staleTime: Infinity,
    retry: false,
  });
  const status = useSourceStatus(created.data ?? null, !!created.data);
  const ready = status?.kind === "ready" && status.source.stream_url ? status.source : null;

  return (
    <Sheet title={t("player.local.title")} subtitle={target.label} onClose={onClose} testId="play-here">
      <div className="space-y-4">
        <div className="rounded-xl bg-surface-2 px-3 py-2.5">
          <p className="text-sm font-semibold">{releaseSummary(release, locale)}</p>
          <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted [overflow-wrap:anywhere]">{release.title}</p>
        </div>
        {created.error ? (
          <Notice error>{sourceErrorMessage(apiErrorCode(created.error), t)}</Notice>
        ) : status?.kind === "error" ? (
          <Notice error>{status.text}</Notice>
        ) : ready ? (
          <ReadyOptions source={ready} target={target} onClose={onClose} />
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3" data-testid="play-here-preparing">
            <Spinner size={20} />
            <div>
              <p className="text-sm font-semibold">{t("player.preparing")}</p>
              {status && <p className="text-xs text-muted">{status.text}</p>}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function Notice({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <p role={error ? "alert" : "note"} className={`flex gap-2 rounded-xl px-3 py-2.5 text-sm ${error ? "bg-danger/10 text-danger" : "bg-surface-2 text-muted"}`}>
      <AlertIcon className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * "Play in browser" first when this browser should handle the file (the
 * source is already prepared, so the player starts right away).
 */
function ReadyOptions({ source, target, onClose }: { source: PlaybackSource; target: PlayTarget; onClose: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const support = useMemo(() => {
    const { probe, env } = thisBrowser();
    return withCompat(assessSource(source, probe, env), compatUsable(source.compat_url ?? null));
  }, [source]);
  if (support.verdict === "unlikely") return <LocalOptions source={source} title={target.label} />;
  return (
    <div className="space-y-4">
    <div className="space-y-1.5">
      <Button
        className="w-full"
        data-option="browser"
        data-testid="play-in-browser"
        onClick={() => {
          onClose();
          navigate(
            watchUrl(
              { media_id: target.media_id, episode_id: target.episode_id, season_number: target.season_number, episode_number: target.episode_number },
              { sourceId: source.id, t: target.position_seconds },
            ),
          );
        }}
      >
        <PlayIcon />
        {t("player.web.play_in_browser")}
      </Button>
      <p className={`text-center text-xs ${support.verdict === "playable" ? "text-ok" : "text-accent"}`}>{verdictLabel(support, t)}</p>
    </div>
    <LocalOptions source={source} title={target.label} demote />
    </div>
  );
}

/** Apps on this phone / computer that can play the stream (also used by the player's fallback). */
export function LocalOptions({ source, title, demote }: { source: PlaybackSource; title: string; demote?: boolean }) {
  const { t } = useI18n();
  const [platform] = useState(() => detectPlatform(navigator.userAgent, navigator.maxTouchPoints));
  const [def] = useState(readLocalDefault);
  const [copied, setCopied] = useState(false);
  const url = absoluteStreamUrl(source.stream_url!, streamFileName(source, title), window.location.origin);
  const { primary, rest } = orderLocalOptions(platform, def);

  const run = (o: LocalPlayer) => {
    if (o === "vlc") window.location.assign(vlcUrl(url));
    else if (o === "intent") window.location.assign(intentUrl(url, title));
    else if (o === "m3u") {
      const blob = new Blob([m3u(url, title)], { type: "audio/x-mpegurl" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeName(title)}.m3u`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } else {
      void navigator.clipboard?.writeText(url).then(
        () => setCopied(true),
        () => window.prompt(t("player.local.copy"), url),
      );
    }
  };
  const icon = (o: LocalPlayer) =>
    o === "m3u" ? <DownloadIcon /> : o === "copy" ? copied ? <CheckIcon /> : <CopyIcon /> : <PlayIcon />;

  return (
    <div className="space-y-3" data-testid="play-here-options" data-platform={platform}>
      {demote && <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("player.local.other_apps")}</p>}
      {primary && !demote && (
        <Button className="w-full" onClick={() => run(primary)} data-option={primary}>
          {icon(primary)}
          {t(LABEL[primary])}
        </Button>
      )}
      {primary && !demote && <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("player.local.more")}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {(demote && primary ? [primary, ...rest] : rest).map((o) => (
          <Button key={o} variant="secondary" className="justify-start" onClick={() => run(o)} data-option={o}>
            {icon(o)}
            {o === "copy" && copied ? t("player.local.copied") : t(LABEL[o])}
          </Button>
        ))}
      </div>
      {platform === "desktop" && <p className="text-xs text-muted">{t("player.local.desktop_hint")}</p>}
      <Notice>{t("player.local.expiry")}</Notice>
    </div>
  );
}
