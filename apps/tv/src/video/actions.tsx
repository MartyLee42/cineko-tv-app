// What OK / holding OK on a video card does: unfinished videos ask
// «Продолжить с 3:12» / «С начала», live streams explain they can't play
// yet, the rest start at once. The long press offers watch later, the
// channel and (in «История») removing it.
import { useState } from "react";
import { useI18n } from "@martytv/ui";
import { unwrap } from "@martytv/contracts";
import { ActionMenu, type MenuAction } from "../components/ActionMenu";
import { formatClock } from "../player/format";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { activeProfile } from "../profile/active";
import { blockReason, resumeAt, type VideoItem } from "./logic";
import { setWatchLater } from "./queries";

export interface VideoMenuHost {
  /** Play from `start` (null = the server's resume position, 0 = the beginning). */
  onPlay: (v: VideoItem, start: number | null) => void;
  onChannel?: (channelId: string, name: string) => void;
}

export interface MoreOpts {
  /** The card is in «Смотреть позже» (offer removing it). */
  inWatchLater?: boolean;
  /** The card is in «История» (offer removing it). */
  inHistory?: boolean;
}

export function useVideoMenu({ onPlay, onChannel }: VideoMenuHost) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ v: VideoItem; subtitle: string | null; actions: MenuAction[] } | null>(null);
  const close = () => setMenu(null);
  const run = (f: () => void) => () => {
    close();
    f();
  };

  const playActions = (v: VideoItem): MenuAction[] => {
    const at = resumeAt(v.progress);
    if (at === null) return [{ key: "play", label: `▶  ${t("video.play")}`, primary: true, onPress: run(() => onPlay(v, 0)) }];
    return [
      { key: "resume", label: `▶  ${t("video.resume", { time: formatClock(at) })}`, primary: true, onPress: run(() => onPlay(v, at)) },
      { key: "start", label: `↺  ${t("video.tv.from_start")}`, onPress: run(() => onPlay(v, 0)) },
    ];
  };

  const blocked = (v: VideoItem) => {
    if (blockReason(v) !== "live") return false;
    setMenu({ v, subtitle: t("video.live_unsupported"), actions: [{ key: "close", label: t("common.close"), primary: true, onPress: close }] });
    return true;
  };

  /** OK on a card. */
  const select = (v: VideoItem) => {
    if (blocked(v)) return;
    if (resumeAt(v.progress) === null) return onPlay(v, 0);
    setMenu({ v, subtitle: v.channel_name, actions: playActions(v) });
  };

  /** Holding OK / ☰ on a card. */
  const more = (v: VideoItem, o: MoreOpts = {}) => {
    if (blocked(v)) return;
    const actions = playActions(v);
    actions.push(
      o.inWatchLater
        ? { key: "wl-remove", label: `✕  ${t("video.remove_watch_later")}`, onPress: run(() => void setWatchLater(v.id, false).catch(() => undefined)) }
        : { key: "wl-add", label: `＋  ${t("video.add_watch_later")}`, onPress: run(() => void setWatchLater(v.id, true).catch(() => undefined)) },
    );
    if (onChannel) actions.push({ key: "channel", label: `${t("video.channel")}: ${v.channel_name}`, onPress: run(() => onChannel(v.channel_id, v.channel_name)) });
    if (o.inHistory) actions.push({ key: "history-remove", label: `✕  ${t("video.tv.remove_history")}`, onPress: run(() => void removeFromHistory(v.id)) });
    setMenu({ v, subtitle: v.channel_name, actions });
  };

  const node = menu && <ActionMenu title={menu.v.title} subtitle={menu.subtitle} actions={menu.actions} testId="video-menu" onCancel={close} />;
  return { select, more, node, open: !!menu };
}

async function removeFromHistory(videoId: string) {
  const profile = activeProfile.get();
  if (!profile) return;
  await unwrap(api.DELETE("/video/history/{video_id}", { params: { path: { video_id: videoId }, query: { profile_id: profile } } })).catch(() => undefined);
  void queryClient.invalidateQueries({ queryKey: ["video", "history"] });
  void queryClient.invalidateQueries({ queryKey: ["video", "continue"] });
}
