// «ТВ» (/tv-channels): live channels with group chips, search, now/next,
// favorites; a channel sheet («Смотреть здесь» / «Включить на ТВ» /
// schedule / hide); the guide grid on desktop; the live player overlay
// (?play=<channel id>).
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { IptvChannel } from "@martytv/contracts";
import { BROKEN_GROUP, offlineLabel } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import { Button, ErrorText, Input, PageTitle } from "../components";
import { CastIcon, CloseIcon, EyeIcon, GearIcon, PlayIcon, SearchIcon } from "../icons";
import { Sheet } from "../remote/SendToTv";
import { useSettings, useUpdateSettings } from "../watch/queries";
import { GuideGrid, ScheduleSheet } from "./Guide";
import { LivePlayer } from "./LivePlayer";
import { ALL, channelChips, filterChannels, togglePlaylist } from "./logic";
import { iptvKey, useChannelPrefs, useChannels, useIptvState } from "./queries";
import { SendChannelProvider, useSendChannel } from "./SendChannel";
import { ChannelLogo, NowNext, StarButton, useGroupLabel, useNow } from "./ui";

export function TvChannelsPage() {
  return (
    <SendChannelProvider>
      <TvChannels />
    </SendChannelProvider>
  );
}

function TvChannels() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const playing = params.get("play");
  const view = params.get("view") === "guide" ? "guide" : "list";
  const [group, setGroup] = useState(ALL);
  const [q, setQ] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sheet, setSheet] = useState<IptvChannel | null>(null);
  const [schedule, setSchedule] = useState<IptvChannel | null>(null);
  const [settings, setSettings] = useState(false);
  const channels = useChannels(showHidden);
  const now = useNow(30_000);
  const label = useGroupLabel();
  const prefs = useChannelPrefs();
  const { send } = useSendChannel();
  const desktop = useDesktop();

  const items = useMemo(() => channels.data?.items ?? [], [channels.data]);
  const chips = useMemo(() => channelChips(channels.data?.groups ?? [], items), [channels.data, items]);
  const shown = filterChannels(items, group, q);
  // The player zaps through what the list shows (falls back to every channel).
  const zapList = shown.some((c) => c.id === playing) ? shown : items;

  const setParam = useCallback(
    (k: string, v: string | null, replace = false) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (v == null) n.delete(k);
          else n.set(k, v);
          return n;
        },
        { replace },
      ),
    [setParams],
  );
  const watch = (c: IptvChannel) => {
    setSheet(null);
    setSchedule(null);
    setParam("play", c.id);
  };
  const closePlayer = useCallback(() => setParam("play", null), [setParam]);
  const zapTo = useCallback((id: string) => setParam("play", id, true), [setParam]);

  return (
    <>
      <div className="space-y-4" data-testid="iptv-page">
        <PageTitle
          action={
            <div className="flex items-center gap-1.5">
              <div role="tablist" className="hidden rounded-full border border-border bg-surface p-1 md:inline-flex">
                {(["list", "guide"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    data-testid={`iptv-view-${v}`}
                    onClick={() => setParam("view", v === "list" ? null : v, true)}
                    className={`min-h-[36px] rounded-full px-4 text-sm font-medium ${view === v ? "bg-accent text-on-accent" : "text-muted hover:text-text"}`}
                  >
                    {v === "list" ? t("iptv.channels") : t("iptv.guide")}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSettings(true)}
                aria-label={t("iptv.web.playlists")}
                data-testid="iptv-settings"
                className="flex h-11 w-11 items-center justify-center rounded-full text-xl text-muted hover:bg-surface-2 hover:text-text"
              >
                <GearIcon />
              </button>
            </div>
          }
        >
          {t("iptv.title")}
        </PageTitle>

        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4" role="tablist" aria-label={t("iptv.channels")} data-testid="iptv-chips">
          {chips
            .filter((c) => c.id !== "favorites" || c.count > 0 || group === "favorites")
            .map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={group === c.id}
                data-group={c.id}
                data-testid="iptv-chip"
                onClick={() => setGroup(c.id)}
                className={`flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm font-medium transition ${
                  group === c.id ? "border-accent bg-accent text-on-accent" : "border-border bg-surface text-text/85 hover:border-muted"
                }`}
              >
                {c.id === "favorites" && <span aria-hidden>★</span>}
                {c.id === BROKEN_GROUP ? t("iptvplay.broken") : c.known ? label(c.id, c.name) : c.name}
                <span className={`text-xs ${group === c.id ? "text-on-accent/75" : "text-muted"}`}>{c.count}</span>
              </button>
            ))}
        </div>

        {view === "list" || !desktop ? (
          <>
            <label className="relative block">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg text-muted" />
              <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("iptv.search")} className="pl-10" data-testid="iptv-search" />
            </label>
            <ErrorText error={channels.error} />
            {channels.isPending ? (
              <div className="flex justify-center p-10">
                <Spinner />
              </div>
            ) : !items.length ? (
              <p className="rounded-2xl border border-dashed border-border p-8 text-center text-muted" data-testid="iptv-empty">
                {t("iptv.empty")}
              </p>
            ) : !shown.length ? (
              <p className="p-8 text-center text-muted">{t("iptv.empty_group")}</p>
            ) : (
              <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2" data-testid="iptv-list">
                {shown.map((c) => (
                  <li key={c.id} className="min-w-0">
                    <ChannelRow
                      c={c}
                      now={now}
                      current={c.id === channels.data?.last_channel_id}
                      onOpen={() => setSheet(c)}
                      onFavorite={() => prefs.mutate({ id: c.id, prefs: { favorite: !c.favorite } })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <GuideGrid group={group} onOpen={setSheet} />
        )}
      </div>
      {/* Overlays live outside the space-y container (its margins would offset fixed elements). */}
      {sheet && (
        <ChannelSheet
          c={sheet}
          now={now}
          onClose={() => setSheet(null)}
          onWatch={() => watch(sheet)}
          onTv={() => {
            setSheet(null);
            send(sheet.id);
          }}
          onSchedule={() => {
            setSchedule(sheet);
            setSheet(null);
          }}
          onHide={() => {
            prefs.mutate({ id: sheet.id, prefs: { hidden: !sheet.hidden } });
            setSheet(null);
          }}
          onFavorite={() => {
            prefs.mutate({ id: sheet.id, prefs: { favorite: !sheet.favorite } });
            setSheet({ ...sheet, favorite: !sheet.favorite });
          }}
        />
      )}
      {schedule && <ScheduleSheet channel={schedule} onClose={() => setSchedule(null)} onWatch={() => watch(schedule)} />}
      {settings && <PlaylistsSheet showHidden={showHidden} onShowHidden={setShowHidden} onClose={() => setSettings(false)} />}
      {playing && <LivePlayer channels={zapList} channelId={playing} onChannel={zapTo} onClose={closePlayer} />}
    </>
  );
}

const DESKTOP = "(min-width: 768px)";

/** md+ (the guide grid is desktop-only; phones get the per-channel schedule). */
function useDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP) : null;
      m?.addEventListener("change", cb);
      return () => m?.removeEventListener("change", cb);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(DESKTOP).matches,
  );
}

function ChannelRow({ c, now, current, onOpen, onFavorite }: { c: IptvChannel; now: number; current: boolean; onOpen: () => void; onFavorite: () => void }) {
  const { t } = useI18n();
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border bg-surface py-2 pl-2 pr-1 transition hover:border-muted ${current ? "border-accent/40" : "border-border"} ${
        c.offline || c.hidden ? "opacity-55" : ""
      }`}
      data-testid="channel-row"
      data-channel-id={c.id}
      data-offline={c.offline}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`${c.number} ${c.name}`}>
        <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-muted">{c.number}</span>
        <ChannelLogo channel={c} size={48} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold" data-testid="channel-name">
              {c.name}
            </span>
            {c.offline && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{t(offlineLabel(c))}</span>}
            {!c.offline && c.health === "codec" && (
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{t("iptvplay.health.codec")}</span>
            )}
            {c.hidden && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{t("iptv.web.hidden")}</span>}
          </span>
          <span className="mt-0.5 block">
            <NowNext now={c.now} next={c.next} at={now} compact />
          </span>
        </span>
      </button>
      <StarButton on={c.favorite} onToggle={onFavorite} />
    </div>
  );
}

function ChannelSheet({
  c,
  now,
  onClose,
  onWatch,
  onTv,
  onSchedule,
  onHide,
  onFavorite,
}: {
  c: IptvChannel;
  now: number;
  onClose: () => void;
  onWatch: () => void;
  onTv: () => void;
  onSchedule: () => void;
  onHide: () => void;
  onFavorite: () => void;
}) {
  const { t } = useI18n();
  const label = useGroupLabel();
  return (
    <Sheet title={c.name} subtitle={`${t("iptv.web.channel_number", { number: c.number })} · ${label(c.group_id, c.group || c.group_id)}`} onClose={onClose} testId="channel-sheet">
      <div className="mb-4 flex items-start gap-3">
        <ChannelLogo channel={c} size={56} />
        <div className="min-w-0 flex-1 pt-1">
          <NowNext now={c.now} next={c.next} at={now} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onWatch} data-testid="channel-watch-here" data-autofocus>
          <PlayIcon /> {t("iptv.web.watch_here")}
        </Button>
        <Button variant="secondary" onClick={onTv} data-testid="channel-play-on-tv">
          <CastIcon /> {t("iptv.web.play_on_tv")}
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
        <Button variant="ghost" onClick={onSchedule} data-testid="channel-schedule" className="!px-2">
          {t("iptv.schedule")}
        </Button>
        <Button variant="ghost" onClick={onFavorite} className="!px-2" aria-pressed={c.favorite}>
          {c.favorite ? "★ " + t("iptv.unfavorite") : "☆ " + t("iptv.favorite")}
        </Button>
        <Button variant="ghost" onClick={onHide} data-testid="channel-hide" className="!px-2">
          <EyeIcon off={!c.hidden} /> {c.hidden ? t("iptv.unhide") : t("iptv.hide")}
        </Button>
      </div>
    </Sheet>
  );
}

function PlaylistsSheet({ showHidden, onShowHidden, onClose }: { showHidden: boolean; onShowHidden: (v: boolean) => void; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const state = useIptvState();
  const settings = useSettings();
  const update = useUpdateSettings();
  const playlists = state.data?.playlists ?? [];
  const current = settings.iptv_playlists ?? "all";
  const ids = playlists.map((p) => p.id);
  const save = (next: "all" | string[]) =>
    update.mutate({ iptv_playlists: next }, { onSuccess: () => void qc.invalidateQueries({ queryKey: iptvKey }) });
  const selected = (id: string) => current === "all" || current.includes(id);

  return (
    <Sheet title={t("iptv.web.playlists")} subtitle={t("iptv.web.playlists_hint")} onClose={onClose} testId="iptv-playlists-sheet">
      <ErrorText error={state.error ?? update.error} />
      {state.isPending ? (
        <Spinner />
      ) : !playlists.length ? (
        <p className="text-muted">{t("iptv.web.no_playlists")}</p>
      ) : (
        <ul className="space-y-1">
          <li>
            <Check checked={current === "all"} onChange={(on) => on && save("all")} label={t("iptv.web.all_playlists")} testId="playlist-all" />
          </li>
          {playlists.map((p) => (
            <li key={p.id}>
              <Check
                checked={selected(p.id)}
                onChange={(on) => save(togglePlaylist(current, ids, p.id, on))}
                label={p.name}
                hint={t("iptv.web.playlist_channels", { count: p.channel_count })}
                testId="playlist-option"
              />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 border-t border-border pt-3">
        <Check checked={showHidden} onChange={onShowHidden} label={t("iptv.web.show_hidden")} testId="show-hidden" />
      </div>
      <Button variant="secondary" className="mt-4 w-full" onClick={onClose}>
        <CloseIcon /> {t("common.close")}
      </Button>
    </Sheet>
  );
}

function Check({ checked, onChange, label, hint, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; testId?: string }) {
  return (
    <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-surface-2" data-testid={testId}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-accent" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}
