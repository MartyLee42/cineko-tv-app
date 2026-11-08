// Home card for «Видео»: phones reach /video from here (the bottom bar keeps
// its 5 items). With an unfinished video it offers «Продолжить просмотр».
import { Link } from "react-router";
import { useI18n } from "@martytv/ui";
import { PlayIcon } from "../icons";
import { useContinue } from "./queries";
import { THUMB_SIZES } from "./prefetch";
import { Thumb, watchHref } from "./ui";

export function HomeVideoCard({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const cont = useContinue();
  const last = cont.data?.[0] ?? null;
  return (
    <div className={`flex flex-col gap-2 sm:flex-row ${className}`} data-testid="video-home-card">
      {last && (
        <Link
          to={watchHref(last.id)}
          data-testid="video-home-continue"
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-3xl border border-accent/30 bg-gradient-to-r from-accent/20 via-accent/5 to-surface p-3 transition hover:border-accent sm:p-3.5"
        >
          <Thumb v={last} className="w-28 shrink-0 !rounded-xl" sizes={THUMB_SIZES.tiny} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold uppercase tracking-wide text-accent">{t("video.web.card_continue")}</span>
            <span className="line-clamp-2 font-bold leading-snug">{last.title}</span>
            <span className="block truncate text-sm text-muted">{last.channel_name}</span>
          </span>
        </Link>
      )}
      <Link
        to="/video"
        data-testid="video-home-open"
        className={`group flex items-center gap-3 rounded-3xl border border-border bg-surface p-3.5 transition hover:border-muted sm:p-4 ${last ? "sm:w-72" : "flex-1"}`}
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red-600 text-2xl text-white">
          <PlayIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold">
            {t("video.title")} · {t("video.web.card_title")}
          </span>
          <span className="block truncate text-sm text-muted">{t("video.web.card_text")}</span>
        </span>
      </Link>
    </div>
  );
}
