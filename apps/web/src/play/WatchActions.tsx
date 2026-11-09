// A release row's two destinations: «Смотреть здесь» (primary) and «Смотреть на ТВ».
import { useI18n } from "@martytv/ui";
import { CastIcon, PlayIcon } from "../icons";

export function WatchHereAction({ onClick, testId }: { onClick: () => void; testId: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex min-h-[40px] items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-bold text-on-accent hover:bg-accent-strong"
    >
      <PlayIcon className="text-sm" />
      {t("player.web.watch_here")}
    </button>
  );
}

export function OnTvAction({ onClick, testId }: { onClick: () => void; testId: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-text/90 hover:border-accent hover:text-text"
    >
      <CastIcon className="text-base" />
      {t("player.play_on_tv")}
    </button>
  );
}
