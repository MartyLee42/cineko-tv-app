import type { PlayerKind } from "@martytv/contracts";
import { useI18n, type MessageKey } from "@martytv/ui";
import { Sheet } from "../remote/SendToTv";
import { PlayIcon } from "../icons";

export const PLAYER_LABEL: Record<PlayerKind, MessageKey> = {
  builtin: "player.kind.builtin",
  msx: "player.kind.msx",
  external: "player.kind.external",
};
const PLAYER_HINT: Record<PlayerKind, MessageKey> = {
  builtin: "player.kind_hint.builtin",
  msx: "player.kind_hint.msx",
  external: "player.kind_hint.external",
};

/** Which of the TV's players opens the stream; tapping one starts playback. */
export function PlayerPicker({
  tv,
  options,
  preselected,
  tvDefault,
  onPick,
  onClose,
}: {
  tv: string;
  options: PlayerKind[];
  preselected: PlayerKind;
  tvDefault: PlayerKind | null;
  onPick: (p: PlayerKind) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Sheet title={t("player.choose_player_title", { tv })} onClose={onClose} testId="player-picker">
      <ul className="space-y-2">
        {options.map((p) => {
          const pre = p === preselected;
          return (
            <li key={p}>
              <button
                type="button"
                onClick={() => onPick(p)}
                data-player={p}
                {...(pre ? { "data-autofocus": true } : {})}
                className={`flex min-h-[64px] w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition hover:border-accent focus-visible:border-accent focus-visible:outline-none ${
                  pre ? "border-accent/60 bg-accent/[0.07]" : "border-border bg-bg/40"
                }`}
              >
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg ${
                    pre ? "bg-accent text-on-accent" : "bg-surface-2 text-text/80"
                  }`}
                >
                  <PlayIcon className="translate-x-px" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{t(PLAYER_LABEL[p])}</span>
                    {p === tvDefault && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
                        {t("player.tv_default")}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-sm leading-snug text-muted">{t(PLAYER_HINT[p])}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
