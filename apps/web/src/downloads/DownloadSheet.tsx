// «Скачать на сервер» from the release list: prepare a source like «Смотреть здесь»,
// wait until it is ready, then POST /downloads (this episode, or the whole season).
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { Release } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { Button } from "../components";
import { AlertIcon, CheckIcon } from "../icons";
import { Sheet } from "../remote/SendToTv";
import { apiErrorCode, createSource } from "../play/queries";
import { releaseSummary, useSourceStatus, type PlayTarget } from "../play/PlayOnTv";
import { sourceErrorMessage } from "../play/releases";
import { canDownloadSeason, createErrorKey } from "./format";
import { useCreateDownload } from "./queries";
import { ServerDownloadIcon, StatusChip } from "./ui";

type Choice = "file" | "season";

export function DownloadSheet({ target, release, onClose }: { target: PlayTarget; release: Release; onClose: () => void }) {
  const { t, locale } = useI18n();
  const seasonable = !!target.episode_id && canDownloadSeason(release);
  // Movies and single episodes start right away; a season pack asks first.
  const [choice, setChoice] = useState<Choice | null>(seasonable ? null : "file");

  return (
    <Sheet title={t("downloads.download_to_server")} subtitle={target.label} onClose={onClose} testId="download-sheet">
      <div className="space-y-4">
        <div className="rounded-xl bg-surface-2 px-3 py-2.5">
          <p className="text-sm font-semibold">{releaseSummary(release, locale)}</p>
          <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted [overflow-wrap:anywhere]">{release.title}</p>
        </div>
        <p className="text-sm leading-relaxed text-muted">{t("downloads.sheet.why")}</p>
        {choice ? (
          <Progress target={target} release={release} season={choice === "season"} onClose={onClose} />
        ) : (
          <div className="space-y-2" data-testid="download-choice">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">{t("downloads.sheet.choose")}</p>
            <Button className="w-full" onClick={() => setChoice("file")} data-testid="download-episode">
              <ServerDownloadIcon />
              {t("downloads.download_episode")}
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => setChoice("season")} data-testid="download-season">
              <ServerDownloadIcon />
              {t("downloads.download_season")}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function Progress({ target, release, season, onClose }: { target: PlayTarget; release: Release; season: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const created = useQuery({
    queryKey: ["here-source", target.media_id, release.id, target.episode_id ?? null],
    queryFn: () =>
      createSource({ media_id: target.media_id, release_id: release.id, ...(target.episode_id && { episode_id: target.episode_id }) }),
    staleTime: Infinity,
    retry: false,
  });
  const status = useSourceStatus(created.data ?? null, !!created.data);
  const ready = status?.kind === "ready" ? status.source : null;
  const create = useCreateDownload();
  const [count, setCount] = useState<number | null>(null);
  const posted = useRef(false);

  useEffect(() => {
    if (!ready || posted.current) return;
    posted.current = true;
    create.mutate({ source_id: ready.id, ...(season && { season: true }) }, { onSuccess: (res) => setCount(res.items.length) });
  }, [ready, season, create]);

  const error = created.error
    ? sourceErrorMessage(apiErrorCode(created.error), t)
    : status?.kind === "error"
      ? status.text
      : create.error
        ? t(createErrorKey(apiErrorCode(create.error)))
        : null;
  if (error) {
    return (
      <p role="alert" className="flex gap-2 rounded-xl bg-danger/10 px-3 py-2.5 text-sm text-danger" data-testid="download-error">
        <AlertIcon className="mt-0.5 shrink-0" />
        <span>{error}</span>
      </p>
    );
  }

  const brief = ready?.download ?? null;
  if (count != null) {
    return (
      <div className="space-y-3" data-testid="download-started">
        <p className="flex items-center gap-2 font-semibold text-ok">
          <CheckIcon />
          {season && count > 1 ? t("downloads.sheet.started_season", { n: count }) : t("downloads.sheet.started")}
        </p>
        {brief && <StatusChip d={brief} />}
        <p className="text-xs text-muted">{t("downloads.sheet.hint_done")}</p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Link
            to="/downloads"
            onClick={onClose}
            data-testid="download-open-list"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-accent px-3 text-center text-sm font-semibold text-on-accent hover:bg-accent-strong"
          >
            {t("downloads.open")}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3" data-testid="download-preparing">
      <Spinner size={20} />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{ready ? t("downloads.sheet.starting") : t("downloads.sheet.preparing")}</p>
        {status && !ready && <p className="text-xs text-muted">{status.text}</p>}
      </div>
    </div>
  );
}
