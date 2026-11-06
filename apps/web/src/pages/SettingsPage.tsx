import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { isAdminRole } from "@martytv/contracts";
import {
  COZY_AMBIENCES,
  DESIGN_SWATCH,
  DESIGNS,
  LOCALES,
  Mascot,
  matrixPillSeen,
  PopcornLoader,
  ProfileAvatar,
  requestPill,
  shouldAskPill,
  Spinner,
  uiSoundsPref,
  useI18n,
  useUiSoundsPref,
  type CozyAmbience,
  type DesignSetting,
  type Locale,
  type MessageKey,
  type ThemeSetting,
} from "@martytv/ui";
import { useSession } from "../session";
import { Card, ErrorText, Field, PageTitle, Select } from "../components";
import { BookmarkIcon, CheckIcon, ChevronRight, HeartIcon, HistoryIcon, ShieldIcon, TvIcon, UserIcon } from "../icons";
import { LocalPlayerField, PasswordCard, SessionsCard, TokensCard } from "./AccountPage";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useProfileSettings, useUpdateSettings } from "../watch/queries";
import { RecoIcon } from "../reco/icons";
import { SourcesCard } from "../play/SourcesSettings";
import { KinopoiskImportCard } from "../imports/KinopoiskImportCard";
import { TasteCard } from "../foryou/TasteCard";
import { ServerDownloadIcon } from "../downloads/ui";
import { VideoQualityRow } from "../video/VideoSettings";
import { LOADING_STYLES, supportsLight, THEMES, type LoadingStyle, type Settings } from "../watch/settings";
import { SeasonalSetting } from "../seasons/SeasonalSetting";
import { ThisDeviceCard } from "../devprefs/ui";

export function SettingsPage() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const isAdmin = isAdminRole(session?.user.role);

  useEffect(() => {
    // /account redirects to /settings#account.
    if (window.location.hash === "#account") document.getElementById("account")?.scrollIntoView();
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>{t("settings.title")}</PageTitle>
      {/* Phones have no Devices in the bottom bar (5 items max): keep it one tap away here. */}
      <Link
        to="/devices"
        data-testid="settings-devices"
        className="flex min-h-[52px] items-center gap-3 rounded-2xl border border-border bg-surface px-4 font-semibold shadow-sm transition hover:border-accent md:hidden"
      >
        <TvIcon className="text-lg text-accent" />
        <span className="flex-1">{t("nav.devices")}</span>
        <ChevronRight className="text-muted" />
      </Link>
      {isAdmin && (
        // Phones have no Admin in the bottom bar: keep it one tap away here.
        <Link
          to="/admin"
          data-testid="settings-admin"
          className="flex min-h-[52px] items-center gap-3 rounded-2xl border border-border bg-surface px-4 font-semibold shadow-sm transition hover:border-accent md:hidden"
        >
          <ShieldIcon className="text-lg text-accent" />
          <span className="flex-1">{t("nav.admin")}</span>
          <ChevronRight className="text-muted" />
        </Link>
      )}
      <ProfileSettingsCard />
      <TasteCard />
      <SourcesCard />
      <LibraryCard isAdmin={isAdmin} />
      <KinopoiskImportCard />
      <DeviceCard />
      <ThisDeviceCard />
      <GuideCard />
      <Card className="border-dashed text-sm text-muted">
        <p data-testid="settings-coming-soon">{t("settings.coming_soon")}</p>
      </Card>
      <h2 id="account" className="scroll-mt-20 pt-4 text-lg font-bold">
        {t("settings.account_section")}
      </h2>
      <SessionsCard />
      <PasswordCard />
      <TokensCard />
    </div>
  );
}

// ---------------------------------------------------------------- guides

/** The PDF guides (served by the web container under /docs/). */
function GuideCard() {
  const { t } = useI18n();
  // The PDF guides are optional (docs/private, not in the public repo): show
  // the card only when the server has them.
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/docs/martytv-guide.pdf", { method: "HEAD" })
      .then((r) => live && setAvailable(r.ok && (r.headers.get("content-type") ?? "").includes("pdf")))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const link = (href: string, label: string, testId: string) => (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      data-testid={testId}
      className="flex min-h-[44px] items-center gap-3 rounded-xl px-2 font-semibold text-accent hover:bg-surface-2"
    >
      <span className="flex-1">{label}</span>
      <span className="text-xs font-normal text-muted">PDF</span>
    </a>
  );
  if (!available) return null;
  return (
    <Card>
      <h2 className="text-lg font-bold">{t("settings.guides")}</h2>
      <p className="mb-2 text-sm text-muted">{t("settings.guides_hint")}</p>
      {link("/docs/martytv-guide.pdf", t("settings.guide_full"), "guide-full")}
      {link("/docs/install-tv.pdf", t("settings.guide_install_tv"), "guide-install-tv")}
    </Card>
  );
}

// ---------------------------------------------------------------- profile

function ProfileSettingsCard() {
  const { t } = useI18n();
  const { profile, profiles, switchTo } = useActiveProfile();
  const q = useProfileSettings();
  const save = useUpdateSettings();
  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => {
    if (!savedAt) return;
    const id = setTimeout(() => setSavedAt(0), 2000);
    return () => clearTimeout(id);
  }, [savedAt]);

  if (!profile) {
    return (
      <Card>
        <p className="text-muted">{t("settings.no_profile")}</p>
        <Link to="/profiles" className="mt-3 inline-flex min-h-[44px] items-center rounded-xl bg-accent px-4 font-semibold text-on-accent">
          {t("profiles.add")}
        </Link>
      </Card>
    );
  }

  const s = q.data;
  const set = (patch: Partial<Settings>) => save.mutate(patch, { onSuccess: () => setSavedAt(Date.now()) });

  return (
    <Card className="space-y-5" >
      <div className="flex flex-wrap items-center gap-3" data-testid="settings-profile">
        <ProfileAvatar name={profile.name} color={profile.color} avatar={profile.avatar} size={44} className="!rounded-full" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold">{t("settings.profile_section", { name: profile.name })}</h2>
          <p className="text-xs text-muted">{t("settings.profile_hint")}</p>
        </div>
        <span
          aria-live="polite"
          data-testid="settings-saved"
          className={`flex items-center gap-1 text-sm font-semibold text-ok transition-opacity ${savedAt ? "opacity-100" : "opacity-0"}`}
        >
          {savedAt ? (
            <>
              <CheckIcon /> {t("settings.saved")}
            </>
          ) : null}
        </span>
      </div>
      {profiles.length > 1 && (
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1" aria-label={t("profile.watching_as")}>
          {profiles.map((p) => {
            const on = p.id === profile.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => !on && switchTo(p)}
                className={`flex min-h-[40px] shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm ${
                  on ? "border-accent bg-accent/10 font-semibold" : "border-border hover:border-muted"
                }`}
              >
                <ProfileAvatar name={p.name} color={p.color} avatar={p.avatar} size={28} className="!rounded-full" />
                {p.name}
                {p.has_pin && !on && <span aria-hidden>🔒</span>}
              </button>
            );
          })}
        </div>
      )}

      {q.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : !s ? (
        <ErrorText error={q.error} />
      ) : (
        <>
          <LookPicker
            design={s.design}
            theme={s.theme}
            onChange={(p) => {
              set(p);
              // «Матрица», the first time in this browser: the red / blue pill.
              const prev = s.design;
              if (p.design && shouldAskPill(p.design, prev, matrixPillSeen())) requestPill({ previous: prev, revert: () => set({ design: prev }) });
            }}
          />

          <div className="divide-y divide-border rounded-xl border border-border">
            <Toggle
              testId="setting-hide-anime"
              label={t("settings.hide_anime")}
              hint={t("settings.hide_anime_hint")}
              on={s.hide_anime}
              onChange={(v) => set({ hide_anime: v })}
            />
            <Toggle
              testId="setting-hide-watched"
              label={t("settings.hide_watched")}
              hint={t("settings.hide_watched_hint")}
              on={s.hide_watched}
              onChange={(v) => set({ hide_watched: v })}
            />
            <Toggle
              testId="setting-autoplay"
              label={t("settings.autoplay_next")}
              on={s.autoplay_next_episode}
              onChange={(v) => set({ autoplay_next_episode: v })}
            />
            <Toggle
              testId="setting-spoiler-free"
              label={t("settings.spoiler_free")}
              hint={t("settings.spoiler_free_hint")}
              on={s.spoiler_free_episodes}
              onChange={(v) => set({ spoiler_free_episodes: v })}
            />
            <VideoQualityRow value={s.video_quality ?? 720} onChange={(q) => set({ video_quality: q })} />
            <Toggle
              testId="setting-video-hide-shorts"
              label={t("video.settings.hide_shorts")}
              on={s.video_hide_shorts ?? true}
              onChange={(v) => set({ video_hide_shorts: v })}
            />
            <Toggle
              testId="setting-poster-wobble"
              label={t("wobble.title")}
              hint={t("wobble.hint_web")}
              on={s.poster_wobble ?? true}
              onChange={(v) => set({ poster_wobble: v })}
            />
          </div>

          <NavTabsSetting hidden={s.hidden_tabs ?? []} onChange={(v) => set({ hidden_tabs: v })} />

          <SeasonalSetting value={s.seasonal_effects ?? "off"} onChange={(v) => set({ seasonal_effects: v })} />

          <CozySetting settings={s} onChange={set} />

          <UiSoundsSetting />

          {/* «Семья советует»: opt-in sharing (off by default) and showing the family (on). */}
          <div>
            <p className="mb-2 text-sm text-muted">{t("family.section")}</p>
            <div className="divide-y divide-border rounded-xl border border-border">
              <Toggle
                testId="setting-share-family"
                label={t("family.share")}
                hint={t("family.share_hint")}
                on={s.share_with_family ?? false}
                onChange={(v) => set({ share_with_family: v })}
              />
              <Toggle
                testId="setting-show-family"
                label={t("family.show")}
                hint={t("family.show_hint")}
                on={s.show_family ?? true}
                onChange={(v) => set({ show_family: v })}
              />
            </div>
          </div>

          {/* «Подборки»: the daily curated-list row on Home (on by default). */}
          <div className="divide-y divide-border rounded-xl border border-border">
            <Toggle
              testId="setting-show-curated"
              label={t("curated.setting")}
              hint={t("curated.setting_hint")}
              on={s.show_curated ?? true}
              onChange={(v) => set({ show_curated: v })}
            />
          </div>

          <div>
            <p className="text-sm text-muted">{t("settings.loading_style")}</p>
            <p className="mb-2 text-xs text-muted">{t("settings.loading_style_hint")}</p>
            <div role="radiogroup" aria-label={t("settings.loading_style")} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {LOADING_STYLES.map((ls) => (
                <LoadingOption key={ls} value={ls} on={s.loading_style === ls} onPick={() => set({ loading_style: ls })} />
              ))}
            </div>
          </div>
          <ErrorText error={save.error} />
        </>
      )}
      <p className="flex gap-2 border-t border-border pt-3 text-xs leading-relaxed text-muted" data-testid="privacy-note">
        <ShieldIcon className="mt-0.5 shrink-0" />
        {t("settings.privacy_note")}
      </p>
    </Card>
  );
}

// Swatches show each design's own colours (DESIGN_SWATCH), independent of the current one.

/** Design cards + colour mode (light only for Кинозал). */
export function LookPicker({
  design,
  theme,
  onChange,
}: {
  design: DesignSetting;
  theme: ThemeSetting;
  onChange: (p: { design?: DesignSetting; theme?: ThemeSetting }) => void;
}) {
  const { t } = useI18n();
  const lightOk = supportsLight(design);
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm text-muted">{t("settings.design")}</p>
        <div role="radiogroup" aria-label={t("settings.design")} className="grid gap-2 sm:grid-cols-3" data-testid="design-picker">
          {DESIGNS.map((d) => {
            const on = d === design;
            const sw = DESIGN_SWATCH[d];
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={on}
                data-value={d}
                onClick={() => onChange({ design: d })}
                className={`flex items-center gap-3 rounded-xl border p-2.5 text-left transition sm:flex-col sm:items-stretch ${
                  on ? "border-accent bg-accent/10 ring-1 ring-accent" : "border-border hover:border-muted"
                }`}
              >
                <span
                  aria-hidden
                  className={`design-swatch design-swatch-${d} relative block h-12 w-16 shrink-0 overflow-hidden rounded-lg ring-1 ring-border sm:h-14 sm:w-full`}
                  style={{ background: sw.bg }}
                >
                  <span className="absolute left-1.5 top-1.5 h-2 w-8 rounded-sm" style={{ background: sw.accent }} />
                  <span className="absolute bottom-1.5 left-1.5 flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="block h-4 w-3 rounded-[3px]" style={{ background: sw.surface, boxShadow: i === 0 ? `inset 0 0 0 1px ${sw.accent2}` : undefined }} />
                    ))}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {on && <CheckIcon className="text-accent" />}
                    {t(`settings.design.${d}` as MessageKey)}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{t(`settings.design.${d}_hint` as MessageKey)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm text-muted">
          {t("settings.theme")}
          {!lightOk && <span className="ml-1.5 text-xs">· {t("settings.dark_only")}</span>}
        </p>
        <div role="radiogroup" aria-label={t("settings.theme")} className="grid grid-cols-3 gap-2" data-testid="theme-picker">
          {THEMES.map((th) => (
            <ThemeOption
              key={th}
              value={th}
              on={lightOk ? theme === th : th === "dark"}
              disabled={!lightOk}
              onPick={() => onChange({ theme: th })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ThemeOption({
  value,
  on,
  onPick,
  disabled,
}: {
  value: ThemeSetting;
  on: boolean;
  onPick: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  // Mini swatch: dark/light halves for "system".
  const swatch =
    value === "dark" ? (
      <span className="block h-full w-full bg-[#08090c]" />
    ) : value === "light" ? (
      <span className="block h-full w-full bg-[#f4f5f0]" />
    ) : (
      <span className="block h-full w-full bg-[linear-gradient(135deg,#f4f5f0_50%,#08090c_50%)]" />
    );
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-value={value}
      disabled={disabled}
      onClick={onPick}
      className={`flex min-h-[48px] items-center gap-2 rounded-xl border px-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
        on ? "border-accent bg-accent/10 text-text" : "border-border text-text/80 hover:border-muted"
      }`}
    >
      <span className="relative h-6 w-6 shrink-0 overflow-hidden rounded-full ring-1 ring-border">{swatch}</span>
      <span className="truncate">{t(`settings.theme.${value}` as MessageKey)}</span>
    </button>
  );
}

type NavTab = NonNullable<Settings["hidden_tabs"]>[number];

/** «Вкладки меню»: which tabs the header (and phone bar) shows for this profile. */
function NavTabsSetting({ hidden, onChange }: { hidden: NavTab[]; onChange: (v: NavTab[]) => void }) {
  const { t } = useI18n();
  const tabs: { id: NavTab; label: string }[] = [
    { id: "tv", label: t("iptv.title") },
    { id: "video", label: t("video.title") },
    { id: "explore", label: t("nav.explore") },
    { id: "new", label: t("newep.title") },
    { id: "history", label: t("nav.history") },
    { id: "ask", label: t("nav.ask") },
    { id: "search", label: t("catalog.search") },
  ];
  return (
    <div data-testid="setting-nav-tabs">
      <p className="text-sm text-muted">{t("nav.tabs_title")}</p>
      <p className="mb-2 text-xs text-muted">{t("nav.tabs_hint")}</p>
      <div className="flex flex-wrap gap-2">
        {tabs.map(({ id, label }) => {
          const on = !hidden.includes(id);
          return (
            <button
              key={id}
              type="button"
              role="switch"
              aria-checked={on}
              data-tab={id}
              onClick={() => onChange(on ? [...hidden, id] : hidden.filter((h) => h !== id))}
              className={`flex min-h-[40px] items-center gap-1.5 rounded-full border px-3.5 text-sm ${
                on ? "border-accent bg-accent/10 font-semibold" : "border-border text-muted hover:border-muted"
              }`}
            >
              {on && <CheckIcon className="text-accent" />}
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Toggle({
  label,
  hint,
  on,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-4 px-3.5 py-3">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        data-testid={testId}
        onClick={() => onChange(!on)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? "bg-accent" : "bg-text/20"}`}
      >
        <span
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left] ${on ? "left-[1.375rem]" : "left-0.5"}`}
        />
      </button>
    </label>
  );
}

/** «Уютный режим»: warm colours, the Home ambience and its quiet sound. */
/** «Звуки интерфейса»: this device's click on buttons (localStorage, off by default). */
function UiSoundsSetting() {
  const { t } = useI18n();
  const on = useUiSoundsPref();
  return (
    <div className="rounded-xl border border-border" data-testid="setting-ui-sounds">
      <Toggle testId="setting-ui-sounds-toggle" label={t("sounds.setting")} hint={t("sounds.setting_hint_web")} on={on} onChange={(v) => uiSoundsPref.set(v)} />
    </div>
  );
}

function CozySetting({ settings, onChange }: { settings: Settings; onChange: (p: Partial<Settings>) => void }) {
  const { t } = useI18n();
  const on = settings.cozy_mode ?? false;
  const ambience = settings.cozy_ambience ?? "fireplace";
  return (
    <div className="divide-y divide-border rounded-xl border border-border" data-testid="setting-cozy">
      <Toggle testId="setting-cozy-mode" label={t("cozy.title")} hint={t("cozy.hint")} on={on} onChange={(v) => onChange({ cozy_mode: v })} />
      {on && (
        <label className="block px-3.5 py-3">
          <span className="block font-medium">{t("cozy.ambience")}</span>
          <span className="mt-0.5 block text-xs text-muted">{t("cozy.ambience_hint")}</span>
          <Select
            className="mt-2 sm:w-72"
            value={ambience}
            onChange={(e) => onChange({ cozy_ambience: e.target.value as CozyAmbience })}
            data-testid="cozy-ambience-select"
            aria-label={t("cozy.ambience")}
          >
            {COZY_AMBIENCES.map((a) => (
              <option key={a} value={a}>
                {t(`cozy.ambience.${a}`)}
              </option>
            ))}
          </Select>
        </label>
      )}
      {on && ambience !== "off" && (
        <Toggle testId="setting-cozy-sound" label={t("cozy.sound")} hint={t("cozy.sound_hint")} on={settings.cozy_sound ?? false} onChange={(v) => onChange({ cozy_sound: v })} />
      )}
    </div>
  );
}

export function LoadingOption({ value, on, onPick }: { value: LoadingStyle; on: boolean; onPick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-value={value}
      onClick={onPick}
      className={`overflow-hidden rounded-xl border text-left transition ${on ? "border-accent ring-1 ring-accent" : "border-border hover:border-muted"}`}
    >
      <LoadingPreview style={value} />
      <span className="flex items-center gap-1.5 px-2.5 py-2 text-sm font-semibold">
        {on && <CheckIcon className="text-accent" />}
        {t(`settings.loading.${value}` as MessageKey)}
      </span>
    </button>
  );
}

/** Tiny looping preview of each TV loading animation (always dark, like the TV). */
export function LoadingPreview({ style }: { style: LoadingStyle }) {
  const backdrop = "bg-[radial-gradient(circle_at_70%_30%,#3b4a6b,#141822_70%)]";
  return (
    <span aria-hidden className={`relative block aspect-video overflow-hidden ${backdrop}`}>
      {style === "popcorn" && <PopcornPreview />}
      {(style === "marty" || style === "marty_popcorn") && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <Mascot size={56} mood={style === "marty" ? "loading" : "popcorn"} animated hat={null} />
          <span className="block h-1 w-1/2 overflow-hidden rounded-full bg-white/20">
            <span className="lp-fill-bar block h-full w-2/3 rounded-full bg-accent" />
          </span>
        </span>
      )}
      {style === "fill_title" && (
        <span className="absolute inset-0 flex items-center gap-1.5 bg-black/35 px-2.5">
          <span className="h-9 w-6 shrink-0 rounded-sm bg-[#6366f1]" />
          <span className="lp-fill-text text-sm font-black uppercase leading-none tracking-tight">Severance</span>
        </span>
      )}
      {style === "poster_reveal" && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="lp-reveal h-[78%] w-[30%] rounded-sm bg-[linear-gradient(160deg,#f97316,#d946ef_55%,#312e81)]" />
        </span>
      )}
      {style === "film_reel" && (
        <span className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col gap-0.5 bg-black/70 py-0.5">
          <span className="lp-strip block h-1 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,.35)_0_6px,transparent_6px_12px)]" />
          <span className="flex gap-1 px-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="lp-frame block h-5 flex-1 rounded-[2px]" style={{ animationDelay: `${i * 0.4}s` }} />
            ))}
          </span>
          <span className="lp-strip block h-1 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,.35)_0_6px,transparent_6px_12px)]" />
        </span>
      )}
      {style === "minimal" && (
        <span className="absolute inset-x-2.5 bottom-2.5 space-y-1">
          <span className="block text-[9px] font-medium text-white/70">Preparing…</span>
          <span className="block h-0.5 overflow-hidden rounded-full bg-white/15">
            <span className="lp-line block h-full bg-accent" />
          </span>
        </span>
      )}
    </span>
  );
}

/** The real PopcornLoader with progress looping 0→1 (remounted each cycle: it never goes backwards). */
function PopcornPreview() {
  const [still] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [tick, setTick] = useState(still ? STEPS : 0);
  useEffect(() => {
    if (still) return;
    const id = setInterval(() => setTick((n) => (n + 1) % (STEPS + 4)), 160);
    return () => clearInterval(id);
  }, [still]);
  const cycle = useCycle(tick);
  return (
    <span className="absolute inset-0 flex items-center justify-center bg-black/30">
      <PopcornLoader key={cycle} progress={Math.min(1, tick / STEPS)} size={84} />
    </span>
  );
}

const STEPS = 20;

/** Counts wrap-arounds of `tick` so the loader remounts at the start of each loop. */
function useCycle(tick: number) {
  const [state, setState] = useState({ cycle: 0, last: tick });
  if (tick < state.last) setState({ cycle: state.cycle + 1, last: tick });
  else if (tick !== state.last) setState({ cycle: state.cycle, last: tick });
  return state.cycle;
}

// ---------------------------------------------------------------- library / device

function LibraryCard({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const links: [string, string, ReactNode][] = [
    ["/lists/watchlist", t("lists.watchlist"), <BookmarkIcon key="w" />],
    ["/lists/favorites", t("lists.favorites"), <HeartIcon key="f" />],
    ["/history", t("watch.history"), <HistoryIcon key="h" />],
    ["/downloads", t("downloads.title"), <ServerDownloadIcon key="dl" />],
    ["/diary", t("nav.diary"), <span key="d">📅</span>],
    ["/taste", t("nav.taste"), <span key="dna">🧬</span>],
    ["/taste-quiz", t("quiz.settings_cta"), <span key="quiz">🎯</span>],
    ["/notes", t("taste.notes.title"), <span key="notes">📝</span>],
    ["/recommendations", t("reco.inbox"), <RecoIcon key="r" />],
    ["/profiles", t("profiles.manage"), <UserIcon key="p" />],
  ];
  if (isAdmin) links.push(["/admin", t("nav.admin"), <ShieldIcon key="a" />]);
  return (
    <Card className="p-2 sm:p-2">
      <h2 className="px-2.5 pb-1 pt-2 text-sm font-semibold text-muted">{t("settings.library")}</h2>
      <ul className="divide-y divide-border">
        {links.map(([to, label, icon]) => (
          <li key={to}>
            <Link to={to} className="flex min-h-[48px] items-center gap-3 rounded-xl px-2.5 hover:bg-surface-2">
              <span className="text-lg text-muted">{icon}</span>
              <span className="flex-1 font-medium">{label}</span>
              <ChevronRight className="text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DeviceCard() {
  const { t, locale, setLocale } = useI18n();
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="text-lg font-bold">{t("settings.device_section")}</h2>
        <p className="text-xs text-muted">{t("settings.device_hint")}</p>
      </div>
      <Field label={t("settings.language")}>
        <Select value={locale} onChange={(e) => setLocale(e.target.value as Locale)} className="sm:w-72" data-testid="language-select">
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {l === "en" ? "English" : "Русский"}
            </option>
          ))}
        </Select>
      </Field>
      <LocalPlayerField />
    </Card>
  );
}
