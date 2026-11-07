import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Profile } from "@martytv/contracts";
import { LOCALE_NAMES, LOCALES, PROFILE_COLORS, ProfileAvatar, useI18n, type Locale, type MessageKey } from "@martytv/ui";
import { api } from "../api";
import { useSession } from "../session";
import { Button, ErrorText, Field, Input, Select } from "../components";
import { TvIcon } from "../icons";
import { AVATARS } from "../pages/ProfilesPage";
import { LoadingOption, LookPicker, Toggle } from "../pages/SettingsPage";
import { Chips, VoiceoverEditor } from "../play/PreferencesForm";
import { formatMaxSize, languageOptions, parseMaxSize, RESOLUTIONS, toggleOrdered, type Preferences } from "../play/prefs";
import { languageName, resolutionLabel } from "../play/releases";
import { useActiveProfile } from "./ActiveProfile";
import {
  buildSavePlan,
  canPromptInstall,
  installHint,
  isStandalone,
  nextStep,
  onboardingEnv,
  prevStep,
  promptInstall,
  shouldShowOnboarding,
  STEPS,
  stepNumber,
  type PrefsDraft,
  type ProfileDraft,
  type Step,
} from "./onboarding";
import { useProfileSettings, useUpdateSettings } from "./queries";
import { LOADING_STYLES, mergeSettings, setLook, type SettingsPatch } from "./settings";

const TITLES: Record<Step, MessageKey> = {
  look: "onboarding.look",
  profile: "onboarding.profile",
  playback: "onboarding.playback",
  content: "onboarding.content",
  loading: "onboarding.loading",
  done: "onboarding.done_title",
};

/** Shows the first-run guide for the active profile until it's finished or skipped. */
export function OnboardingGate() {
  const { profile } = useActiveProfile();
  const settings = useProfileSettings();
  const [env] = useState(onboardingEnv);
  if (!profile || !shouldShowOnboarding(settings.data, env)) return null;
  return <Onboarding key={profile.id} profile={profile} />;
}

function Onboarding({ profile }: { profile: Profile }) {
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const navigate = useNavigate();
  const current = mergeSettings(useProfileSettings().data);
  const saveSettings = useUpdateSettings();
  const prefsQ = useQuery({
    queryKey: ["profile-prefs", profile.id],
    queryFn: () => unwrap(api.GET("/profiles/{id}/preferences", { params: { path: { id: profile.id } } })),
  });

  const [step, setStep] = useState<Step>("look");
  const [settings, setSettings] = useState<SettingsPatch>({});
  const [draft, setDraft] = useState<ProfileDraft>({ name: profile.name, avatar: profile.avatar, color: profile.color });
  const [prefs, setPrefs] = useState<PrefsDraft | null>(null);
  const [maxSize, setMaxSize] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const s = mergeSettings(current, settings);
  const patch = (p: SettingsPatch) => setSettings((cur) => ({ ...cur, ...p }));
  const basePrefs: PrefsDraft | null = prefsQ.data
    ? {
        preferred_audio_languages: prefsQ.data.preferred_audio_languages,
        preferred_voiceovers: prefsQ.data.preferred_voiceovers ?? [],
        preferred_resolution: prefsQ.data.preferred_resolution,
        max_size_gb: prefsQ.data.max_size_gb,
      }
    : null;
  const p = prefs ?? basePrefs;
  const setP = (x: Partial<PrefsDraft>) => p && setPrefs({ ...p, ...x });

  // Live preview while choosing.
  useEffect(() => {
    setLook({ ...(settings.theme && { theme: settings.theme }), ...(settings.design && { design: settings.design }) });
  }, [settings.theme, settings.design]);

  // Lock page scroll behind the guide.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const finish = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const size = maxSize == null ? undefined : parseMaxSize(maxSize);
      const plan = buildSavePlan({
        settings,
        profile: draft,
        initialProfile: profile,
        prefs: p ? { ...p, ...(size !== undefined && size !== "invalid" && { max_size_gb: size }) } : null,
        initialPrefs: prefsQ.data,
      });
      if (plan.profile) {
        await unwrap(api.PATCH("/profiles/{id}", { params: { path: { id: profile.id } }, body: plan.profile }));
        void qc.invalidateQueries({ queryKey: ["profiles"] });
      }
      if (plan.prefs) {
        const saved = await unwrap(api.PUT("/profiles/{id}/preferences", { params: { path: { id: profile.id } }, body: plan.prefs as Preferences }));
        qc.setQueryData(["profile-prefs", profile.id], saved);
      }
      await saveSettings.mutateAsync(plan.settings);
      return true;
    } catch (e) {
      setError(e);
      setSaving(false);
      return false;
    }
  };

  const n = stepNumber(step);
  const total = STEPS.length;
  const name = session?.user.display_name || session?.user.username || draft.name;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      data-testid="onboarding"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-bg sm:items-center sm:bg-black/50 sm:p-6 sm:backdrop-blur-sm"
    >
      <div className="flex w-full flex-col bg-bg sm:max-h-[min(46rem,100%)] sm:max-w-xl sm:overflow-hidden sm:rounded-3xl sm:border sm:border-border sm:shadow-2xl sm:shadow-black/40">
        {/* header */}
        <div className="shrink-0 px-5 pb-3 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-7 sm:pt-6">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">{t("onboarding.step", { n, total })}</p>
            {step !== "done" && (
              <button
                type="button"
                onClick={() => void finish()}
                disabled={saving}
                data-testid="onboarding-skip"
                className="min-h-[36px] rounded-lg px-2 text-sm font-medium text-muted hover:text-text"
              >
                {t("onboarding.skip")}
              </button>
            )}
          </div>
          <div className="mt-2.5 flex gap-1.5" aria-hidden>
            {STEPS.map((x, i) => (
              <span key={x} className={`h-1 flex-1 rounded-full transition ${i < n ? "bg-accent" : "bg-text/15"}`} />
            ))}
          </div>
          {step === "look" && (
            <div className="mt-5">
              <p className="text-2xl font-extrabold leading-tight sm:text-3xl">{t("onboarding.welcome", { name })}</p>
              <p className="mt-1.5 text-sm text-muted">{t("onboarding.intro")}</p>
            </div>
          )}
          <h2 id="onboarding-title" className={`${step === "look" ? "mt-6 text-lg" : "mt-5 text-2xl"} font-bold`}>
            {t(TITLES[step])}
          </h2>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 sm:px-7">
          {step === "look" && (
            <div className="space-y-5">
              <LookPicker design={s.design} theme={s.theme} onChange={patch} />
              <Field label={t("settings.language")}>
                <Select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                  {LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {LOCALE_NAMES[l]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          {step === "profile" && (
            <div className="space-y-5">
              <div className="flex items-center gap-4">
                <ProfileAvatar name={draft.name || "?"} color={draft.color} avatar={draft.avatar} size={72} />
                <div className="flex-1">
                  <Field label={t("profiles.name")}>
                    <Input value={draft.name} maxLength={32} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </Field>
                </div>
              </div>
              <Picker label={t("profiles.avatar")}>
                {AVATARS.map((a) => (
                  <button
                    type="button"
                    key={a || "initial"}
                    aria-pressed={a === draft.avatar}
                    onClick={() => setDraft({ ...draft, avatar: a })}
                    className={`flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-xl ${a === draft.avatar ? "ring-2 ring-accent" : ""}`}
                  >
                    {a || (draft.name.trim()[0] ?? "A").toUpperCase()}
                  </button>
                ))}
              </Picker>
              <Picker label={t("profiles.color")}>
                {PROFILE_COLORS.map((c) => (
                  <button
                    type="button"
                    key={c}
                    aria-label={c}
                    aria-pressed={c === draft.color}
                    onClick={() => setDraft({ ...draft, color: c })}
                    className={`h-10 w-10 rounded-full ${c === draft.color ? "ring-2 ring-text ring-offset-2 ring-offset-bg" : ""}`}
                    style={{ background: c }}
                  />
                ))}
              </Picker>
            </div>
          )}

          {step === "playback" &&
            (!p ? (
              <ErrorText error={prefsQ.error} />
            ) : (
              <div className="space-y-5">
                <Picker label={t("player.prefs.audio")} hint={t("player.prefs.order_hint")}>
                  <Chips
                    testId="onb-audio"
                    options={languageOptions(p.preferred_audio_languages).map((l) => ({
                      value: l,
                      label: languageName(l, locale),
                      short: l.toUpperCase(),
                    }))}
                    selected={p.preferred_audio_languages}
                    onToggle={(v) => setP({ preferred_audio_languages: toggleOrdered(p.preferred_audio_languages, v) })}
                  />
                </Picker>
                <Picker label={t("player.prefs.voiceovers")} hint={t("player.prefs.voiceovers_hint")}>
                  <VoiceoverEditor value={p.preferred_voiceovers ?? []} onChange={(v) => setP({ preferred_voiceovers: v })} />
                </Picker>
                <Picker label={t("player.prefs.resolution")}>
                  {RESOLUTIONS.map((r) => {
                    const on = r === p.preferred_resolution;
                    return (
                      <button
                        key={r || "any"}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setP({ preferred_resolution: r })}
                        className={`min-h-[40px] rounded-xl border px-3.5 text-sm font-semibold transition ${
                          on ? "border-accent bg-accent text-on-accent" : "border-border bg-surface text-text/85 hover:border-muted"
                        }`}
                      >
                        {r ? resolutionLabel(r) : t("player.prefs.any")}
                      </button>
                    );
                  })}
                </Picker>
                <Field label={`${t("player.prefs.max_size")} (GB)`}>
                  <Input
                    inputMode="decimal"
                    className="max-w-[10rem]"
                    value={maxSize ?? formatMaxSize(p.max_size_gb)}
                    placeholder={t("player.prefs.no_limit")}
                    onChange={(e) => setMaxSize(e.target.value)}
                  />
                </Field>
              </div>
            ))}

          {step === "content" && (
            <div className="divide-y divide-border rounded-xl border border-border bg-surface">
              <Toggle label={t("settings.hide_anime")} hint={t("settings.hide_anime_hint")} on={s.hide_anime} onChange={(v) => patch({ hide_anime: v })} />
              <Toggle label={t("settings.hide_watched")} hint={t("settings.hide_watched_hint")} on={s.hide_watched} onChange={(v) => patch({ hide_watched: v })} />
              <Toggle
                label={t("settings.spoiler_free")}
                hint={t("settings.spoiler_free_hint")}
                on={s.spoiler_free_episodes}
                onChange={(v) => patch({ spoiler_free_episodes: v })}
              />
              <Toggle label={t("settings.autoplay_next")} on={s.autoplay_next_episode} onChange={(v) => patch({ autoplay_next_episode: v })} />
            </div>
          )}

          {step === "loading" && (
            <div className="space-y-3">
              <p className="text-sm text-muted">{t("settings.loading_style_hint")}</p>
              <div role="radiogroup" aria-label={t("settings.loading_style")} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {LOADING_STYLES.map((ls) => (
                  <LoadingOption key={ls} value={ls} on={s.loading_style === ls} onPick={() => patch({ loading_style: ls })} />
                ))}
              </div>
            </div>
          )}

          {step === "done" && <DoneStep onPair={() => void finish().then((ok) => ok && navigate("/pair"))} />}
          <div className="mt-3">
            <ErrorText error={error} />
          </div>
        </div>

        {/* footer */}
        <div className="flex shrink-0 gap-2.5 border-t border-border px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-7 sm:pb-5">
          {step !== "look" && (
            <Button variant="secondary" onClick={() => setStep(prevStep(step))} disabled={saving}>
              {t("onboarding.back")}
            </Button>
          )}
          {step === "done" ? (
            <Button className="ml-auto min-w-[8rem]" busy={saving} onClick={() => void finish()} data-testid="onboarding-finish">
              {t("onboarding.finish")}
            </Button>
          ) : (
            <Button className="ml-auto min-w-[8rem]" onClick={() => setStep(nextStep(step))} data-testid="onboarding-next">
              {t("onboarding.next")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Picker({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function DoneStep({ onPair }: { onPair: () => void }) {
  const { t } = useI18n();
  const [hint, setHint] = useState(() => installHint(navigator.userAgent, isStandalone(), canPromptInstall()));
  return (
    <div className="space-y-5">
      <p className="text-muted">{t("onboarding.done_body")}</p>
      <button
        type="button"
        onClick={onPair}
        className="flex w-full items-center gap-4 rounded-2xl border border-accent/40 bg-accent/10 p-4 text-left transition hover:bg-accent/15"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-2xl text-on-accent">
          <TvIcon />
        </span>
        <span className="font-semibold">{t("home.pair_cta")}</span>
      </button>
      {hint && (
        <div className="rounded-2xl border border-border bg-surface p-4 text-sm" data-testid="install-tip">
          <p>{t("onboarding.install_tip")}</p>
          {hint === "ios" ? (
            <p className="mt-1.5 text-muted">{t("onboarding.install_ios")}</p>
          ) : (
            <Button
              variant="secondary"
              className="mt-3"
              onClick={() => void promptInstall().then(() => setHint(null))}
            >
              {t("onboarding.install")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
