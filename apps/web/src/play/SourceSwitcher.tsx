import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type DeviceState, type PlaybackSource, type Release } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { Button, Card } from "../components";
import { AlertIcon, CheckIcon, ListIcon } from "../icons";
import { errorMessage, errorOutcome, formatClock } from "../remote/logic";
import { sendCommand } from "../remote/state";
import { Sheet } from "../remote/SendToTv";
import { apiErrorCode, createSource, usePlaybackSource } from "./queries";
import { releaseSummary, useSourceStatus } from "./PlayOnTv";
import { ReleaseList } from "./ReleaseList";
import { episodeFromLabel, languageCode, rankingProfileId, sourceErrorMessage, type ReleaseTarget } from "./releases";

class SourceFailed extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** What is playing on the TV: its release, plus a switcher to another one (media.select_source). */
export function SourceCard({ deviceId, s }: { deviceId: string; s: DeviceState }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const p = s.playback!;
  const current = usePlaybackSource(p.source_id);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Release | null>(null);

  const ep = episodeFromLabel(p.episode_label);
  const target: ReleaseTarget = {
    media_id: p.media_id,
    ...(p.episode_id && {
      episode_id: p.episode_id,
      ...(ep ? { season_number: ep.season, episode_number: ep.episode } : s.season_number != null ? { season_number: s.season_number } : {}),
    }),
  };

  const sw = useMutation({
    mutationFn: async (r: Release): Promise<PlaybackSource> => {
      const profileId = rankingProfileId(s);
      const src = await createSource({
        media_id: p.media_id,
        release_id: r.id,
        ...(p.episode_id && { episode_id: p.episode_id }),
        ...(profileId && { profile_id: profileId }),
      }).catch((e: unknown) => {
        throw new SourceFailed(apiErrorCode(e));
      });
      if (src.status === "error") throw new SourceFailed(src.error ?? "failed");
      await sendCommand(qc, deviceId, "media.select_source", { source_id: src.id });
      return src;
    },
  });
  const switched = sw.data ?? null;
  const status = useSourceStatus(switched, !!switched);
  const onTv = switched && p.source_id === switched.id;

  let error: string | null = null;
  if (sw.error instanceof SourceFailed) error = sourceErrorMessage(sw.error.code, t);
  else if (sw.error) {
    const o = errorOutcome(sw.error);
    error = o.kind === "error" ? errorMessage(o.code, t) : null;
  }

  const rel = current.data?.release;

  return (
    <Card>
      <div data-testid="source-card" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-bold">{t("player.source")}</h2>
          <Button
            variant="secondary"
            className="min-h-[40px] px-3 text-sm"
            onClick={() => {
              sw.reset();
              setOpen(true);
            }}
            disabled={sw.isPending}
            data-testid="change-source"
          >
            <ListIcon />
            {t("player.change_source")}
          </Button>
        </div>
        {rel ? (
          <div className="space-y-1">
            <p className="text-sm font-semibold">
              {releaseSummary(rel, locale)}
              {rel.languages.length > 0 && <span className="ml-2 text-xs font-bold text-muted">{rel.languages.map(languageCode).join(" ")}</span>}
            </p>
            <p className="line-clamp-2 break-words text-xs text-muted [overflow-wrap:anywhere]">{rel.title}</p>
          </div>
        ) : (
          <p className="text-sm text-muted">{p.source_id ? <Spinner size={16} /> : t("player.source_auto")}</p>
        )}
        {(sw.isPending || switched || error) && (
          <p
            role={error ? "alert" : "status"}
            data-testid="switch-status"
            className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${error ? "bg-danger/10 text-danger" : "bg-surface-2 text-text/85"}`}
          >
            {error ? (
              <AlertIcon className="shrink-0" />
            ) : onTv || status?.kind === "ready" ? (
              <CheckIcon className="shrink-0 text-ok" />
            ) : (
              <Spinner size={14} />
            )}
            {error ??
              (sw.isPending
                ? t("player.switching")
                : onTv
                  ? t("player.switched")
                  : status?.kind === "error"
                    ? status.text
                    : `${t("player.preparing")}${status ? ` · ${status.text}` : ""}`)}
          </p>
        )}
      </div>

      {open && (
        <Sheet
          wide
          title={t("player.change_source")}
          subtitle={[p.title, p.episode_label].filter(Boolean).join(" · ")}
          onClose={() => setOpen(false)}
          testId="source-sheet"
        >
          <ReleaseList
            target={target}
            profileId={rankingProfileId(s)}
            profileName={s.profile_name}
            deviceId={deviceId}
            currentId={rel?.id}
            onPick={(r) => {
              setOpen(false);
              setPending(r);
            }}
          />
        </Sheet>
      )}
      {pending && (
        <Sheet title={t("player.switch_title")} onClose={() => setPending(null)} role="alertdialog">
          <div data-testid="switch-confirm" className="space-y-3">
            <p className="text-text/85">{t("player.switch_body", { time: formatClock(p.position_seconds) })}</p>
            <div className="rounded-xl bg-surface-2 px-3 py-2.5">
              <p className="text-sm font-semibold">{releaseSummary(pending, locale)}</p>
              <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted [overflow-wrap:anywhere]">{pending.title}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                data-autofocus
                onClick={() => setPending(null)}
                className="min-h-[48px] rounded-xl bg-surface-2 font-semibold hover:bg-border"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  sw.mutate(pending);
                  setPending(null);
                }}
                className="min-h-[48px] rounded-xl bg-accent font-semibold text-on-accent hover:bg-accent-strong"
              >
                {t("player.switch")}
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </Card>
  );
}
