// Setting rows shared by the Settings screen and the first-run guide, and
// the live loading-animation preview.
import { useEffect, useMemo, useState } from "react";
import type { PlayerKind } from "@martytv/contracts";
import { imageUrl } from "@martytv/media-types";
import { matrixPillSeen, requestPill, shouldAskPill, useI18n, type Locale } from "@martytv/ui";
import { useCatalogConfig, useHome } from "../catalog/queries";
import { Loader } from "../player/Loader";
import type { LoadStage } from "../player/loading";
import { currentEnv, currentPlayers, defaultPlayerStore, externalHiddenInMsx } from "../players/select";
import { DESIGNS, LOADING_STYLES, POSTER_RATINGS, THEMES, useSaveSettings, useSettings, type LoadingStyle, type Settings } from "../profile/settings";
import { useActiveProfileId } from "../profile/active";
import { calmMotion, useCalmMotion } from "../design/skins";
import { introPref } from "../intro/logic";
import { SAVER_STYLES, saverPref, type SaverStyle } from "../idle/logic";
import type { Choice, Row } from "./OptionList";
import { DEFAULT_MIN_VOTES, MIN_VOTES_CHOICES, truncateNote } from "./taste";

const LOADING_LABEL = {
  popcorn: "settings.loading.popcorn",
  fill_title: "settings.loading.fill_title",
  poster_reveal: "settings.loading.poster_reveal",
  film_reel: "settings.loading.film_reel",
  minimal: "settings.loading.minimal",
  marty: "settings.loading.marty",
  marty_popcorn: "settings.loading.marty_popcorn",
} as const;

export function useSettingRows() {
  const { t, locale, setLocale } = useI18n();
  const settings = useSettings();
  const profileId = useActiveProfileId();
  const save = useSaveSettings();
  const [player, setPlayer] = useState(() => defaultPlayerStore.get());
  const calm = useCalmMotion();
  const [intro, setIntro] = useState(() => introPref.get());
  const [saver, setSaver] = useState(() => saverPref.get());
  const available = useMemo(() => currentPlayers(), []);

  const set = (patch: Partial<Settings>) => {
    if (profileId) save.mutate({ id: profileId, patch });
  };
  const onOff: Choice<unknown>[] = [
    { value: true, label: t("tv.settings.on") },
    { value: false, label: t("tv.settings.off") },
  ];
  const bool = (key: "hide_anime" | "hide_watched" | "autoplay_next_episode" | "spoiler_free_episodes" | "video_hide_shorts", label: string, hint?: string): Row => ({
    kind: "choice",
    key,
    label,
    hint,
    choices: onOff,
    value: settings[key],
    onChange: (v) => set({ [key]: v as boolean }),
  });

  const players: Choice<unknown>[] = [
    { value: null, label: t("player.tv.player.ask") },
    { value: "builtin", label: t("player.tv.player.builtin") },
  ];
  if (available.includes("msx") || player === "msx") players.push({ value: "msx", label: t("player.tv.player.msx") });
  if (available.includes("external") || player === "external") players.push({ value: "external", label: t("player.tv.player.external") });

  const rows = {
    design: {
      kind: "choice",
      key: "design",
      label: t("settings.design"),
      hint: t(`settings.design.${settings.design}_hint`),
      choices: DESIGNS.map((v) => ({ value: v, label: t(`settings.design.${v}`) })),
      value: settings.design,
      onChange: (v) => {
        const next = v as Settings["design"];
        const prev = settings.design;
        set({ design: next });
        // «Матрица», the first time on this TV: the red / blue pill.
        if (shouldAskPill(next, prev, matrixPillSeen())) requestPill({ previous: prev, revert: () => set({ design: prev }) });
      },
    } as Row,
    // «Каркас»: this TV's background motion (device-local, see design/skins.tsx).
    motion: {
      kind: "choice",
      key: "calm_motion",
      label: t("designs.motion"),
      hint: settings.design === "matrix" ? t("designs.motion_hint_matrix") : t("designs.motion_hint"),
      choices: [
        { value: false, label: t("designs.motion.on") },
        { value: true, label: t("designs.motion.calm") },
      ],
      value: calm,
      onChange: (v) => calmMotion.set(v as boolean),
    } as Row,
    // This TV's startup animation (device-local, intro/logic.ts).
    intro: {
      kind: "choice",
      key: "startup_intro",
      label: t("designs.intro"),
      hint: t("designs.intro_hint"),
      choices: onOff,
      value: intro,
      onChange: (v) => {
        introPref.set(v === true);
        setIntro(v === true);
      },
    } as Row,
    // This TV's screensaver on idle Home (device-local, idle/logic.ts).
    saver: {
      kind: "choice",
      key: "screensaver",
      label: t("idle.saver"),
      hint: t("idle.saver_hint"),
      choices: SAVER_STYLES.map((v) => ({ value: v, label: t(`idle.saver.${v}`) })),
      value: saver,
      onChange: (v) => {
        saverPref.set(v as SaverStyle);
        setSaver(v as SaverStyle);
      },
    } as Row,
    theme: {
      kind: "choice",
      key: "theme",
      label: t("settings.theme"),
      choices: THEMES.map((v) => ({ value: v, label: t(`settings.theme.${v}`) })),
      value: settings.theme,
      onChange: (v) => set({ theme: v as Settings["theme"] }),
    } as Row,
    posterRating: {
      kind: "choice",
      key: "poster_rating",
      label: t("settings.poster_rating"),
      choices: POSTER_RATINGS.map((v) => ({ value: v, label: t(`settings.poster_rating.${v}`) })),
      value: settings.poster_rating,
      onChange: (v) => set({ poster_rating: v as Settings["poster_rating"] }),
    } as Row,
    loading: {
      kind: "choice",
      key: "loading_style",
      label: t("settings.loading_style"),
      hint: settings.loading_style === "popcorn" ? t("settings.loading.popcorn_hint") : undefined,
      choices: LOADING_STYLES.map((v) => ({ value: v, label: t(LOADING_LABEL[v]) })),
      value: settings.loading_style,
      onChange: (v) => set({ loading_style: v as LoadingStyle }),
    } as Row,
    hideAnime: bool("hide_anime", t("settings.hide_anime"), t("settings.hide_anime_hint")),
    hideWatched: bool("hide_watched", t("settings.hide_watched"), t("settings.hide_watched_hint")),
    autoplay: bool("autoplay_next_episode", t("settings.autoplay_next")),
    spoilers: bool("spoiler_free_episodes", t("settings.spoiler_free"), t("settings.spoiler_free_hint")),
    // «Видео» (YouTube): the playback height cap and Shorts.
    videoQuality: {
      kind: "choice",
      key: "video_quality",
      label: t("video.settings.quality"),
      hint: t("video.settings.quality_hint"),
      choices: ([480, 720, 1080] as const).map((v) => ({ value: v, label: `${v}p` })),
      value: settings.video_quality,
      onChange: (v) => set({ video_quality: v as Settings["video_quality"] }),
    } as Row,
    hideShorts: bool("video_hide_shorts", t("video.settings.hide_shorts"), t("video.tv.hide_shorts_hint")),
    player: {
      kind: "choice",
      key: "default_player",
      label: t("settings.default_player"),
      hint: externalHiddenInMsx(currentEnv()) ? `${t("player.tv.player.ask_desc")} ${t("tvplay.ext.msx_hint")}` : t("player.tv.player.ask_desc"),
      choices: players,
      value: player,
      onChange: (v) => {
        defaultPlayerStore.set(v as PlayerKind | null);
        setPlayer(v as PlayerKind | null);
      },
    } as Row,
    minVotes: {
      kind: "choice",
      key: "min_votes",
      label: t("taste.tv.min_votes"),
      hint: t("taste.min_votes_hint"),
      choices: MIN_VOTES_CHOICES.map((n) => ({
        value: n,
        label: n === 0 ? t("taste.min_votes.0") : t(n === DEFAULT_MIN_VOTES ? "taste.min_votes.default" : "taste.min_votes.n", { n: n.toLocaleString(locale) }),
      })),
      value: settings.min_votes,
      onChange: (v) => set({ min_votes: v as Settings["min_votes"] }),
    } as Row,
    language: {
      kind: "choice",
      key: "language",
      label: t("settings.language"),
      choices: [
        { value: "en", label: "English" },
        { value: "ru", label: "Русский" },
      ],
      value: locale,
      onChange: (v) => setLocale(v as Locale),
    } as Row,
  };
  /** «О моих вкусах»: OK opens the keyboard editor (onOpen). */
  const tasteNote = (onOpen: () => void): Row => ({
    kind: "text",
    key: "taste_note",
    label: t("taste.tv.note"),
    hint: t("taste.tv.note_hint"),
    value: truncateNote(settings.taste_note),
    empty: t("taste.tv.note_empty"),
    onOpen,
  });
  return { rows, settings, saveError: save.isError, set, tasteNote };
}

const STAGES: [number, LoadStage][] = [
  [0.12, "searching"],
  [0.35, "metadata"],
  [0.85, "preloading"],
  [1.01, "starting"],
];

/**
 * A live thumbnail of a loading style: the real component rendered at
 * 1920×1080 and scaled down, with simulated progress looping.
 */
export function LoaderPreview({ style, width = 640 }: { style: LoadingStyle; width?: number }) {
  const { t } = useI18n();
  const cfg = useCatalogConfig();
  const home = useHome();
  const sample = useMemo(() => {
    for (const r of home.data?.rows ?? []) for (const it of r.items) if (it.backdrop_path && it.poster_path) return it;
    return null;
  }, [home.data]);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((n) => (n + 1) % 28), 300);
    return () => clearInterval(id);
  }, []);
  const p = Math.min(1, step / 24);
  const stage = STAGES.find(([max]) => p < max)?.[1] ?? "starting";
  const scale = width / 1920;
  return (
    <div className="relative overflow-hidden rounded-2xl shadow-2xl" style={{ width, height: 1080 * scale }}>
      <div className="tv-preview absolute left-0 top-0" style={{ transform: `scale(${scale})` }}>
        {/* Restart (no reverse animation) when the loop wraps. */}
        <Loader
          key={step === 0 ? "a" : "b"}
          preview
          style={style}
          m={{
            p,
            stage,
            title: sample?.title ?? t("app.name"),
            episode: null,
            poster: imageUrl(cfg.data, sample?.poster_path, "w500"),
            backdrop: imageUrl(cfg.data, sample?.backdrop_path, "w1280"),
            seed: sample?.id ?? "preview",
            torrent: { peers: 24, seeders: 18, download_speed_bps: 4_400_000, preloaded_bytes: Math.round(p * 28_000_000) },
          }}
        />
      </div>
    </div>
  );
}
