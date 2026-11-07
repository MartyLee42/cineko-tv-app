import { useState } from "react";
import type { Profile } from "@martytv/contracts";
import { useEffectiveDesign, useI18n } from "@martytv/ui";
import { OptionRows, ROW_GAP, ROW_H, useOptionKeys, type Row } from "./OptionList";
import { LoaderPreview, useSettingRows } from "./rows";
import { DeviceInfo } from "./DeviceInfo";
import { useSourceRows } from "./sources";
import { TasteNoteEditor } from "./TasteNoteEditor";
import { DesignFavorites } from "./DesignFavorites";
import { TasteQuiz } from "../taste/TasteQuiz";
import { useQuizState } from "../taste/data";
import { useQuizGenerate } from "../taste/useQuizGenerate";
import { DesignPreviews, SkinBackground } from "../design/skins";
import { SEASON_PREVIEW_ROW, SeasonPreviewPanel, useSeasonRows } from "./seasonRows";
import { useDevicePlaybackRows } from "./deviceRows";
import { useCozyRows } from "./cozyRows";
import { useFamilyRows } from "./familyRows";
import { useHealthPref } from "../health/agent";
import { tvOwn } from "./tvOwn";

/** Designs with a moving background layer: the «Движение фона» row shows for them. */
const MOTION_DESIGNS = new Set<string>(["wireframe", "matrix", "mult", "tarkovsky", "silent"]);

/**
 * Settings (side menu): the profile's settings (saved on the server, applied
 * at once) and this TV's own (default player, language). Back closes.
 */
export function SettingsScreen({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useI18n();
  const { rows: r, settings, saveError, set, tasteNote, favorites } = useSettingRows();
  const [editingNote, setEditingNote] = useState(false);
  const [pickingFavs, setPickingFavs] = useState(false);
  // «Сюрприз»: the design shown today (may differ from the chosen one).
  const shown = useEffectiveDesign(settings, profile.id) ?? settings.design;
  const looks = [settings.design, shown];
  const [quiz, setQuiz] = useState(false);
  const quizState = useQuizState();
  const quizGen = useQuizGenerate(profile.id);
  const [info, setInfo] = useState(false);
  const sourceRows = useSourceRows();
  const season = useSeasonRows(settings, set);
  const cozy = useCozyRows(settings, set);
  const family = useFamilyRows(settings, set);
  // «Это устройство»: this TV's playback profile (release picks).
  const playback = useDevicePlaybackRows();
  // «Отправлять состояние ТВ» (this TV only, on by default).
  const healthOn = useHealthPref();
  const rows: Row[] = [
    { kind: "header", key: "h-profile", label: t("settings.profile_section", { name: profile.name }), hint: t("devset.tv.profile_hint") },
    r.design,
    r.surprise,
    ...(settings.design_surprise !== "off" ? [favorites(() => setPickingFavs(true))] : []),
    ...(looks.some((l) => MOTION_DESIGNS.has(l)) ? [r.motion] : []),
    // Light colours exist for «Кинозал» only.
    ...(looks.includes("kinozal") ? [r.theme] : []),
    r.loading,
    r.filmTheme,
    ...season.rows,
    ...cozy,
    r.posterRating,
    r.hideAnime,
    r.hideWatched,
    r.autoplay,
    r.countdown,
    r.skipSegments,
    r.spoilers,
    ...family,
    tasteNote(() => setEditingNote(true)),
    {
      kind: "actions",
      key: "taste-quiz",
      actions: [{ key: "quiz", label: quizState.data?.completed_at ? t("quiz.settings_done") : t("quiz.settings_cta"), onPress: () => setQuiz(true) }],
    },
    { kind: "actions", key: "quiz-generate", actions: [quizGen.action] },
    r.minVotes,
    r.videoQuality,
    r.hideShorts,
    r.videoAutoplay,
    ...sourceRows,
    { kind: "header", key: "h-device", label: t("settings.device_section"), hint: t("tv.settings.device_hint") },
    r.player,
    r.intro,
    r.saver,
    r.sounds,
    r.language,
    ...playback.rows,
    {
      kind: "choice",
      key: "health-report",
      label: t("health.setting"),
      hint: t("health.setting_hint"),
      choices: [
        { value: true, label: t("tvplay.on") },
        { value: false, label: t("tvplay.off") },
      ],
      value: healthOn,
      onChange: (v: unknown) => tvOwn.set("health_report", v === true),
    } as Row,
    { kind: "actions", key: "device-info", actions: [{ key: "about", label: t("tvd.info.title"), onPress: () => setInfo(true) }] },
    { kind: "note", key: "note", label: `${t("settings.coming_soon")} ${t("settings.privacy_note")}` },
  ];
  const [focused, setFocused] = useState("theme");
  const { index } = useOptionKeys({ rows, onBack: onClose, onFocusRow: setFocused });
  const row = rows[index];

  // Scroll so the focused row stays in view (rows have fixed heights).
  const pitch = ROW_H + ROW_GAP;
  const scroll = Math.max(0, (index - 6) * pitch);

  return (
    <div data-testid="tv-settings" className="absolute left-0 top-0 z-30 h-full w-full bg-bg">
      <SkinBackground dim />
      <div className="absolute left-[120px] top-[70px]">
        <h1 className="text-6xl font-bold">{t("settings.title")}</h1>
        {saveError && <p className="mt-3 text-2xl text-danger">{t("tv.settings.save_failed")}</p>}
        {quizGen.note && (
          <p data-testid="tv-settings-quiz-gen" data-status={quizGen.note.kind} className={`mt-3 line-clamp-2 max-w-[1680px] text-2xl ${quizGen.note.kind === "error" ? "text-danger" : "text-accent"}`}>
            {quizGen.note.text}
          </p>
        )}
        {playback.note && (
          <p data-testid="tv-settings-playback-note" className="mt-3 text-2xl text-accent">
            {playback.note}
          </p>
        )}
      </div>
      <div className="absolute bottom-0 left-[120px] top-[170px] w-[1000px] overflow-hidden">
        <div className="tv-track pb-20" style={{ transform: `translate3d(0,${-scroll}px,0)` }}>
          <OptionRows rows={rows} index={index} action={0} />
        </div>
      </div>
      <aside className="absolute left-[1200px] right-[100px] top-[200px]">
        {focused === SEASON_PREVIEW_ROW ? (
          <SeasonPreviewPanel key={season.preview} season={season.preview} setting={settings.seasonal_effects} />
        ) : focused === "loading_style" ? (
          <>
            <p className="mb-5 text-2xl text-muted">{t("tv.settings.preview")}</p>
            <LoaderPreview key={settings.loading_style} style={settings.loading_style} width={620} />
          </>
        ) : focused === "design" || focused === "design_surprise" || focused === "design_favorites" ? (
          <>
            <p className="text-4xl font-semibold">{focused === "design" ? t(`settings.design.${settings.design}`) : row?.kind === "choice" || row?.kind === "text" ? row.label : ""}</p>
            {shown !== settings.design && (
              <p data-testid="tv-settings-surprise-today" className="mt-3 text-2xl font-semibold text-accent">
                {t(settings.design_surprise === "week" ? "surprise.this_week" : "surprise.today", { design: t(`settings.design.${shown}`) })}
              </p>
            )}
            <p className="mb-8 mt-4 text-2xl leading-snug text-muted">
              {focused === "design" ? t(`settings.design.${settings.design}_hint`) : row?.kind === "choice" || row?.kind === "text" ? row.hint : ""}
            </p>
            <DesignPreviews current={settings.design} width={186} stars={settings.design_surprise !== "off" ? settings.design_favorites : undefined} />
          </>
        ) : (
          (row?.kind === "choice" || row?.kind === "text") && (
            <div>
              <p className="text-4xl font-semibold">{row.label}</p>
              {row.hint && <p className="mt-5 text-2xl leading-snug text-muted">{row.hint}</p>}
            </div>
          )
        )}
      </aside>
      {info && <DeviceInfo onClose={() => setInfo(false)} />}
      {pickingFavs && <DesignFavorites favorites={settings.design_favorites} onChange={(next) => set({ design_favorites: next })} onClose={() => setPickingFavs(false)} />}
      {quiz && <TasteQuiz profileId={profile.id} onClose={() => setQuiz(false)} />}
      {editingNote && (
        <TasteNoteEditor
          initial={settings.taste_note}
          onClose={() => setEditingNote(false)}
          onSave={(note) => {
            set({ taste_note: note });
            setEditingNote(false);
          }}
        />
      )}
    </div>
  );
}
