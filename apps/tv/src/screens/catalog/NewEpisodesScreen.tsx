import { useState } from "react";
import { unwrap } from "@martytv/contracts";
import { airedKey, catalogLang, daysSinceAir, episodeCode, imageUrl, placeholderColor } from "@martytv/media-types";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { api } from "../../api";
import { FocusButton, FocusLine, setFocus, useInitialFocus } from "../../focus";
import type { RouteMemory } from "../../catalog/nav";
import { useCatalogConfig } from "../../catalog/queries";
import { ActionMenu, type MenuAction } from "../../components/ActionMenu";
import { Slot } from "../../components/HRow";
import { Img, legacyColor } from "../../components/Img";
import { ErrorState } from "../../components/States";
import { useDesign, useFrame, usePlural } from "../../design/context";
import { ScreenTitle } from "../../design/grid";
import { useReportDeep, useToTop } from "../../design/topJump";
import { useActiveProfileId } from "../../profile/active";
import { refreshWatchData } from "../../watch/api";
import { useMarkNewSeen, useMuteSeries, useNewEpisodes, type NewEpisodeItem } from "../../newepisodes/data";

const ITEM_H = 176;
const ITEM_PITCH = ITEM_H + 20;
const LIST_TOP = 150;

/** «Вышла 3 дня назад» for an air date. */
export function useAiredText() {
  const { t } = useI18n();
  const plural = usePlural();
  return (air: string | null | undefined): string => {
    const k = airedKey(daysSinceAir(air));
    if (!k) return "";
    return k.key === "newep.aired_days" ? plural("newep.aired_days", k.n) : t(k.key as MessageKey);
  };
}

/**
 * «Новые серии»: episodes of the profile's series that came out after what it
 * watched (the server checks every night). OK plays the episode; holding OK
 * offers «О сериале», «Отметить просмотренной», «Скрыть» and «Не уведомлять
 * о сериале» (unmuting lives in the PWA).
 */
export function NewEpisodesScreen({
  mem,
  onPlay,
  onOpen,
  onHome,
}: {
  mem: RouteMemory;
  onPlay: (it: NewEpisodeItem) => void;
  onOpen: (it: NewEpisodeItem) => void;
  onHome: () => void;
}) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const cfg = useCatalogConfig();
  const q = useNewEpisodes();
  const mark = useMarkNewSeen();
  const mute = useMuteSeries();
  const profile = useActiveProfileId();
  const aired = useAiredText();
  const items = q.data?.items ?? [];
  const unseen = q.data?.unseen ?? 0;
  const [idx, setIdx] = useState(() => mem.get<number>("idx") ?? 0);
  const [menu, setMenu] = useState<{ it: NewEpisodeItem; actions: MenuAction[] } | null>(null);
  const keys = [...(unseen > 0 ? ["ne-all"] : []), ...items.map((it) => `ne-${it.episode.id}`)];
  useInitialFocus(!q.isPending, mem, () => (items[0] ? `ne-${items[0].episode.id}` : q.isError ? "ne-retry" : "ne-home"));
  const scroll = Math.max(0, idx - 2) * ITEM_PITCH;
  const square = design === "terminal";
  useToTop(() => {
    setIdx(0);
    mem.set("idx", 0);
    return false;
  });
  useReportDeep(scroll > 0);

  const more = (it: NewEpisodeItem) => {
    const close = () => setMenu(null);
    const actions: MenuAction[] = [
      { key: "watch", label: `▶  ${t("newep.watch")}`, primary: true, onPress: () => (close(), onPlay(it)) },
      { key: "details", label: t("newep.details"), onPress: () => (close(), onOpen(it)) },
      {
        key: "watched",
        label: `✓  ${t("newep.mark_watched")}`,
        onPress: () => {
          close();
          void unwrap(
            api.PUT("/media/{id}/watched", {
              params: { path: { id: it.media.id }, query: { lang: catalogLang(locale) } },
              body: { profile_id: profile!, watched: true, episode_id: it.episode.id },
            }),
          )
            .then(() => refreshWatchData(false))
            .catch(() => undefined);
          mark.mutate({ episode_ids: [it.episode.id] });
        },
      },
    ];
    if (!it.seen) actions.push({ key: "hide", label: t("newep.hide"), onPress: () => (close(), mark.mutate({ episode_ids: [it.episode.id] })) });
    actions.push({
      key: "mute",
      label: t("newepmute.mute"),
      onPress: () => {
        close();
        // The series' rows disappear: move the focus to the nearest row left
        // (the one after it, else before), or Home when none is.
        const at = items.indexOf(it);
        const other = (x: NewEpisodeItem) => x.media.id !== it.media.id;
        const next = items.slice(at + 1).find(other) ?? items.slice(0, at).reverse().find(other);
        mute.mutate(it.media.id);
        setTimeout(() => setFocus(next ? `ne-${next.episode.id}` : "ne-home"), 0);
      },
    });
    setMenu({ it, actions });
  };

  return (
    <div data-testid="new-episodes" className="absolute overflow-hidden" style={{ left: frame.x, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <div className="flex h-[136px] items-end pb-6">
        <ScreenTitle design={design} index={8}>
          {t("newep.title")}
        </ScreenTitle>
        {unseen > 0 && <span className="mb-1 ml-6 text-2xl text-accent">{t("newep.count", { n: unseen })}</span>}
        {items.length > 0 && <span className="mb-1 ml-6 text-2xl text-muted">{t("newep.hint")}</span>}
      </div>
      {q.isPending ? (
        <Spinner size={56} />
      ) : q.isError ? (
        <ErrorState focusKey="ne-retry" error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <div data-testid="new-episodes-empty">
          <p className="max-w-[1200px] text-[30px] leading-snug text-muted">{t("newep.empty")}</p>
          <div className="mt-10 flex">
            <FocusButton focusKey="ne-home" onPress={onHome} className={`bg-surface-2 px-10 py-5 text-[28px] font-bold ${square ? "" : "rounded-control"}`}>
              {t("nav.home")}
            </FocusButton>
          </div>
        </div>
      ) : (
        <div className="absolute bottom-0 left-0 right-[96px] overflow-hidden" style={{ top: LIST_TOP }}>
          <FocusLine focusKey="ne-list" keys={keys} className="tv-track relative" style={{ transform: `translate3d(0,${-scroll}px,0)` }}>
            {unseen > 0 && (
              <div className="mb-[20px] flex h-[64px]">
                <FocusButton
                  focusKey="ne-all"
                  onFocus={() => (setIdx(0), mem.set("idx", 0))}
                  onPress={() => mark.mutate({ all: true })}
                  className={`tv-chip bg-surface-2 px-8 py-3 text-[24px] font-semibold ${square ? "t-label text-[20px]" : "rounded-control"}`}
                >
                  ✓ {t("newep.mark_all")}
                </FocusButton>
              </div>
            )}
            <div className="relative" style={{ height: items.length * ITEM_PITCH }}>
              {items.map((it, i) => {
                const still = it.episode.still_path ?? it.media.backdrop_path ?? null;
                return (
                  <Slot
                    key={it.episode.id}
                    focusKey={`ne-${it.episode.id}`}
                    left={0}
                    top={i * ITEM_PITCH}
                    width={1300}
                    onFocus={() => {
                      setIdx(i + (unseen > 0 ? 1 : 0));
                      mem.set("idx", i + (unseen > 0 ? 1 : 0));
                    }}
                    onPress={() => onPlay(it)}
                    onLongPress={() => more(it)}
                  >
                    {(f) => (
                      <div
                        data-new-episode={it.episode.id}
                        data-seen={it.seen ? "1" : "0"}
                        className={`tv-focus tv-flat flex overflow-hidden bg-surface ${square ? "" : "rounded-card"} ${f ? "is-focused" : ""} ${it.seen && !f ? "opacity-60" : ""}`}
                        style={{ height: ITEM_H }}
                      >
                        <div className="relative shrink-0" style={{ width: 312, height: ITEM_H, background: legacyColor(placeholderColor(it.media.id)) }}>
                          {still && <Img src={imageUrl(cfg.data, still, "w300")} className="absolute left-0 top-0 h-full w-full object-cover" />}
                        </div>
                        <div className="min-w-0 flex-1 px-8 py-5">
                          <div className="flex items-center text-[22px] text-muted">
                            {!it.seen && (
                              <span className={`mr-4 bg-accent px-3 text-[18px] font-bold text-on-accent ${square ? "t-label" : "rounded-full"}`}>{t("newep.badge_new")}</span>
                            )}
                            <span className="truncate">{aired(it.episode.air_date)}</span>
                            {it.source === "kinopoisk" && (
                              <span data-source="kinopoisk" className={`ml-4 shrink-0 border border-text/30 px-2 text-[17px] ${square ? "t-label" : "rounded-full"}`}>
                                {t("newep.from_kinopoisk")}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 truncate text-[34px] font-bold">{it.media.title}</p>
                          <p className="mt-1 truncate text-[26px] text-text/85">
                            <span className="font-semibold text-accent">{episodeCode(it.episode.season_number, it.episode.episode_number)}</span>
                            {it.episode.name ? ` · ${it.episode.name}` : ""}
                          </p>
                        </div>
                      </div>
                    )}
                  </Slot>
                );
              })}
            </div>
          </FocusLine>
        </div>
      )}
      {menu && (
        <ActionMenu
          testId="new-episode-menu"
          title={menu.it.media.title}
          subtitle={`${episodeCode(menu.it.episode.season_number, menu.it.episode.episode_number)}${menu.it.episode.name ? ` · ${menu.it.episode.name}` : ""}`}
          actions={menu.actions}
          onCancel={() => setMenu(null)}
        />
      )}
    </div>
  );
}
