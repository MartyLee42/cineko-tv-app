import { useEffect, useMemo } from "react";
import type { PlayerKind, Release } from "@martytv/contracts";
import { useI18n, type MessageKey } from "@martytv/ui";
import { FocusButton, FocusLine, setFocus } from "../focus";
import { player } from "../player/controller";
import { episodeLabel, releaseRow } from "../player/format";
import type { PlayContext } from "../player/session";
import { availablePlayers, currentEnv, defaultPlayerStore, externalHiddenInMsx, type ExternalApp, type PlayerChoice } from "./select";

interface Option {
  key: string;
  choice: PlayerChoice;
  title: MessageKey;
  desc: MessageKey;
  /** Shown first and marked: MSX's player when external apps can't open here. */
  recommended?: boolean;
}

const APPS: { app: ExternalApp; title: MessageKey }[] = [
  { app: "system", title: "player.tv.app.system" },
  { app: "vlc", title: "player.tv.app.vlc" },
  { app: "mx", title: "player.tv.app.mx" },
];

/** Concrete options for the players available on this TV. */
export function playerOptions(available: readonly PlayerKind[], msxRecommended = false): Option[] {
  const out: Option[] = [];
  if (available.includes("builtin")) out.push({ key: "builtin", choice: { player: "builtin" }, title: "player.tv.player.builtin", desc: "player.tv.player.builtin_desc" });
  if (available.includes("msx"))
    out.push({
      key: "msx",
      choice: { player: "msx" },
      title: "player.tv.player.msx",
      desc: msxRecommended ? "tvplay.player.msx_recommended" : "player.tv.player.msx_desc",
      recommended: msxRecommended,
    });
  if (available.includes("external"))
    for (const a of APPS) out.push({ key: `ext-${a.app}`, choice: { player: "external", app: a.app }, title: a.title, desc: "player.tv.player.external_desc" });
  return out;
}

/** "Play with…": shown after picking a release when the TV asks every time. */
export function PlayerChooser({ ctx, release }: { ctx: PlayContext; release: Release | null }) {
  const { t, locale } = useI18n();
  // Inside MSX without the launch action, external apps would only error:
  // they're hidden, MSX's player is recommended and a hint says why.
  const env = useMemo(() => currentEnv(), []);
  const msxHint = externalHiddenInMsx(env);
  const options = useMemo(() => playerOptions(availablePlayers(env), msxHint), [env, msxHint]);
  const def = defaultPlayerStore.get();
  useEffect(() => {
    const first = options.find((o) => o.choice.player === def) ?? options[0];
    if (first) void setFocus(`pc-${first.key}`);
  }, [options, def]);
  const ep = episodeLabel(ctx.season, ctx.episode, ctx.episode_name);
  const row = release ? releaseRow(release, locale) : null;
  return (
    <div data-testid="player-chooser" className="absolute left-0 top-0 h-full w-full bg-bg">
      <div className="absolute left-24 right-24 top-24">
        <p className="text-3xl text-accent">{t("player.tv.play_with")}</p>
        <h1 className="mt-3 truncate text-6xl font-bold">{ctx.title}</h1>
        <p className="mt-4 h-10 truncate text-3xl text-muted">
          {[ep, row ? [row.resolution, ...row.chips, row.size].join(" · ") : null].filter(Boolean).join("  ·  ")}
        </p>
        <FocusLine focusKey="pc" keys={options.map((o) => `pc-${o.key}`)} className="mt-14 w-[1200px]">
          {options.map((o) => (
            <FocusButton
              key={o.key}
              focusKey={`pc-${o.key}`}
              onPress={() => player.choosePlayer(o.choice)}
              className="tv-option mb-6 block rounded-card bg-surface px-10 py-7"
              focusedClassName="tv-option-focused"
            >
              <p className="text-4xl font-semibold">
                {t(o.title)}
                {o.recommended && <span className="ml-5 rounded-full bg-accent px-4 py-1 align-middle text-xl text-on-accent">★</span>}
                {o.choice.player === def && <span className="ml-5 rounded-full bg-surface-2 px-4 py-1 align-middle text-xl text-muted">{t("player.tv.default")}</span>}
              </p>
              <p className="mt-2 text-2xl text-muted">{t(o.desc)}</p>
            </FocusButton>
          ))}
        </FocusLine>
        {msxHint && (
          <p data-testid="player-chooser-msx-hint" className="mt-4 w-[1200px] text-2xl text-muted">
            {t("tvplay.ext.msx_hint")}
          </p>
        )}
      </div>
    </div>
  );
}
