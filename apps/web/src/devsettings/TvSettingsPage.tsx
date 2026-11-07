// Устройства → a TV → «Настройки ТВ»: any TV of the household, edited from a
// phone or a computer. Its own options (screensaver, sounds, language…) and,
// per profile, how that profile looks and plays on this TV. Changes reach the
// TV at once (realtime settings.changed); offline TVs pick them up on start.
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { unwrap, type ProfileSettings } from "@martytv/contracts";
import {
  LOCALE_NAMES,
  LOCALES,
  ProfileAvatar,
  SAVER_SETTINGS,
  SEASONAL_SETTINGS,
  Spinner,
  StatusDot,
  useI18n,
  withTvOwnDefaults,
  type LayeredKey,
  type Locale,
  type SeasonalSetting,
  type TvOwnSettings,
} from "@martytv/ui";
import { api } from "../api";
import { useDevices } from "../queries";
import { useSession } from "../session";
import { Button, Card, ErrorText, PageTitle, Select } from "../components";
import { ChevronRight } from "../icons";
import { useDeviceState } from "../remote/state";
import { DevicePrefsButton } from "../devprefs/ui";
import { CozySetting, LoadingOption, LookPicker, Toggle } from "../pages/SettingsPage";
import { LOADING_STYLES, mergeSettings, type Settings } from "../watch/settings";
import { useSaveTvSettings, useTvSettings, type TvOwn } from "./queries";

/** The TV's name (own / shared list, or every TV for a super_admin). */
function useTvName(id: string): { name: string | null; online: boolean | undefined } {
  const own = useDevices();
  const { data: session } = useSession();
  const d = own.data?.find((x) => x.id === id);
  const all = useQuery({
    queryKey: ["devices", "all"],
    queryFn: async () => (await unwrap(api.GET("/devices", { params: { query: { scope: "all" } } }))).items,
    enabled: !!own.data && !d && session?.user.role === "super_admin",
  });
  const any = d ?? all.data?.find((x) => x.id === id);
  return { name: any?.name ?? null, online: any?.online };
}

export function TvSettingsPage() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const [pick, setPick] = useState<string | undefined>();
  const q = useTvSettings(id, pick);
  const v = q.data;
  const profileId = v?.profile_id ?? undefined;
  const save = useSaveTvSettings(id, pick);
  const { name, online: listed } = useTvName(id);
  const live = useDeviceState(id);
  const online = live.data?.online ?? listed;

  const notFound = (q.error as { status?: number } | null)?.status === 404;
  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="tv-settings-page">
      <Link to="/devices" className="inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold text-accent">
        <ChevronRight className="rotate-180" /> {t("devset.tv.back")}
      </Link>
      <PageTitle>
        <span className="flex items-center gap-2">
          {online !== undefined && <StatusDot online={online} />}
          {t("devset.tv.title", { name: name ?? "TV" })}
        </span>
      </PageTitle>
      <p className="-mt-2 text-sm text-muted" data-testid="tv-settings-live">
        {online === false ? t("devset.tv.offline") : t("devset.tv.hint")}
      </p>
      {notFound ? (
        <Card>
          <p className="text-muted">{t("devset.tv.not_found")}</p>
        </Card>
      ) : !v ? (
        q.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <ErrorText error={q.error} />
        )
      ) : (
        <>
          <ErrorText error={save.error} />
          {v.profiles.length === 0 ? (
            <Card>
              <p className="text-muted">{t("devset.tv.no_profiles")}</p>
            </Card>
          ) : (
            <ProfileCard
              view={v}
              onPick={(pid) => setPick(pid)}
              onChange={(patch) => profileId && save.mutate({ profile_id: profileId, profile: patch as ProfileSettings })}
              onReset={(keys) => profileId && save.mutate({ profile_id: profileId, reset: keys })}
            />
          )}
          <OwnCard deviceId={id} name={name ?? "TV"} own={v.device} onChange={(device) => save.mutate({ device: device as TvOwn })} />
        </>
      )}
    </div>
  );
}

/** «своё для ТВ · Как в профиле» above a control whose keys are set on this TV. */
function Layered({ keys, overrides, onReset, children }: { keys: LayeredKey[]; overrides: Partial<Settings>; onReset: (k: LayeredKey[]) => void; children: ReactNode }) {
  const { t } = useI18n();
  const set = keys.filter((k) => overrides[k] !== undefined && overrides[k] !== null);
  return (
    <div data-testid={`layer-${keys[0]}`} data-own={set.length > 0 ? "1" : "0"}>
      {set.length > 0 && (
        <div className="mb-1.5 flex items-center gap-2 text-xs">
          <span className="rounded-full bg-accent/15 px-2 py-0.5 font-semibold text-accent">{t("devset.tv.own_badge")}</span>
          <button type="button" className="min-h-[32px] font-semibold text-muted underline-offset-2 hover:text-text hover:underline" onClick={() => onReset(set)} data-testid="layer-reset">
            {t("devset.tv.reset")}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

function ProfileCard({
  view: v,
  onPick,
  onChange,
  onReset,
}: {
  view: NonNullable<ReturnType<typeof useTvSettings>["data"]>;
  onPick: (id: string) => void;
  onChange: (p: Partial<Settings>) => void;
  onReset: (keys: LayeredKey[]) => void;
}) {
  const { t } = useI18n();
  const s = mergeSettings(v.effective ?? undefined);
  const over = (v.overrides ?? {}) as Partial<Settings>;
  const current = v.profiles.find((p) => p.id === v.profile_id);
  const ownKeys = Object.keys(over).filter((k) => over[k as keyof Settings] !== undefined) as LayeredKey[];
  const L = (keys: LayeredKey[], children: ReactNode) => (
    <Layered keys={keys} overrides={over} onReset={onReset}>
      {children}
    </Layered>
  );
  return (
    <Card className="space-y-5">
      <div>
        <p className="mb-2 text-sm text-muted">{t("devset.tv.profile")}</p>
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1" data-testid="tv-settings-profiles">
          {v.profiles.map((p) => {
            const on = p.id === v.profile_id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => !on && onPick(p.id)}
                className={`flex min-h-[40px] shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm ${on ? "border-accent bg-accent/10 font-semibold" : "border-border hover:border-muted"}`}
              >
                <ProfileAvatar name={p.name} color={p.color} avatar={p.avatar} size={28} className="!rounded-full" />
                {p.name}
                {p.id === v.active_profile_id && <span className="text-xs font-normal text-accent">· {t("devset.tv.now_showing")}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-bold">{t("devset.tv.look")}</h2>
        <p className="text-xs text-muted">{t("devset.tv.look_hint", { name: current?.name ?? "" })}</p>
      </div>
      {L(
        ["design", "theme", "design_surprise", "design_favorites"],
        <LookPicker
          design={s.design}
          theme={s.theme}
          surprise={{ profileId: v.profile_id ?? "", mode: s.design_surprise, favorites: s.design_favorites, onChange }}
          onChange={onChange}
        />,
      )}
      {L(
        ["loading_style"],
        <div>
          <p className="mb-2 text-sm text-muted">{t("settings.loading_style")}</p>
          <div role="radiogroup" aria-label={t("settings.loading_style")} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {LOADING_STYLES.map((ls) => (
              <LoadingOption key={ls} value={ls} on={s.loading_style === ls} onPick={() => onChange({ loading_style: ls })} />
            ))}
          </div>
        </div>,
      )}
      {L(
        ["seasonal_effects"],
        <label className="block rounded-xl border border-border px-3.5 py-3">
          <span className="block font-medium">{t("seasons.setting")}</span>
          <Select
            className="mt-2 sm:w-72"
            value={s.seasonal_effects ?? "off"}
            onChange={(e) => onChange({ seasonal_effects: e.target.value as SeasonalSetting })}
            data-testid="tv-seasonal"
            aria-label={t("seasons.setting")}
          >
            {SEASONAL_SETTINGS.map((m) => (
              <option key={m} value={m}>
                {t(`seasons.mode.${m}`)}
              </option>
            ))}
          </Select>
        </label>,
      )}
      {L(["cozy_mode", "cozy_ambience", "cozy_sound"], <CozySetting settings={s} onChange={onChange} />)}
      {L(
        ["poster_wobble"],
        <div className="rounded-xl border border-border">
          <Toggle testId="tv-wobble" label={t("wobble.title")} hint={t("wobble.hint_tv")} on={s.poster_wobble ?? true} onChange={(on) => onChange({ poster_wobble: on })} />
        </div>,
      )}

      <h2 className="pt-2 text-lg font-bold">{t("devset.tv.playback")}</h2>
      <div className="space-y-3">
        {L(
          ["autoplay_next_episode"],
          <div className="rounded-xl border border-border">
            <Toggle testId="tv-autoplay" label={t("settings.autoplay_next")} on={s.autoplay_next_episode} onChange={(on) => onChange({ autoplay_next_episode: on })} />
          </div>,
        )}
        {L(
          ["autoplay_countdown"],
          <div className="rounded-xl border border-border">
            <Toggle
              testId="tv-countdown"
              label={t("settings.autoplay_countdown")}
              hint={t("settings.autoplay_countdown_hint")}
              on={s.autoplay_countdown ?? true}
              onChange={(on) => onChange({ autoplay_countdown: on })}
            />
          </div>,
        )}
        {L(
          ["skip_segments"],
          <label className="block rounded-xl border border-border px-3.5 py-3">
            <span className="block font-medium">{t("skip.setting")}</span>
            <span className="mt-0.5 block text-xs text-muted">{t("skip.setting_hint")}</span>
            <Select
              className="mt-2 sm:w-72"
              value={s.skip_segments ?? "button"}
              onChange={(e) => onChange({ skip_segments: e.target.value as Settings["skip_segments"] })}
              data-testid="tv-skip"
              aria-label={t("skip.setting")}
            >
              {(["button", "auto", "off"] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`skip.mode.${m}`)}
                </option>
              ))}
            </Select>
          </label>,
        )}
        {L(
          ["video_autoplay"],
          <div className="rounded-xl border border-border">
            <Toggle
              testId="tv-video-autoplay"
              label={t("video.settings.autoplay")}
              hint={t("video.settings.autoplay_hint")}
              on={s.video_autoplay ?? true}
              onChange={(on) => onChange({ video_autoplay: on })}
            />
          </div>,
        )}
      </div>
      {ownKeys.length > 0 && (
        <Button variant="secondary" onClick={() => onReset(ownKeys)} data-testid="tv-reset-all">
          {t("devset.tv.reset_all")}
        </Button>
      )}
    </Card>
  );
}

function OwnCard({ deviceId, name, own, onChange }: { deviceId: string; name: string; own: TvOwnSettings; onChange: (p: TvOwnSettings) => void }) {
  const { t, locale } = useI18n();
  const s = withTvOwnDefaults(own, locale as NonNullable<TvOwnSettings["language"]>);
  const toggle = (k: "ui_sounds" | "startup_intro" | "health_report" | "slow_hint" | "show_prebuffer" | "speedtest", label: string, hint?: string) => (
    <Toggle testId={`tv-own-${k}`} label={label} hint={hint} on={s[k]} onChange={(on) => onChange({ [k]: on })} />
  );
  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-bold" data-testid="tv-own">{t("devset.tv.own")}</h2>
      <div className="divide-y divide-border rounded-xl border border-border">
        <label className="block px-3.5 py-3">
          <span className="block font-medium">{t("idle.saver")}</span>
          <span className="mt-0.5 block text-xs text-muted">{t("idle.saver_hint")}</span>
          <Select className="mt-2 sm:w-72" value={s.screensaver} onChange={(e) => onChange({ screensaver: e.target.value as TvOwnSettings["screensaver"] })} data-testid="tv-own-screensaver" aria-label={t("idle.saver")}>
            {SAVER_SETTINGS.map((v) => (
              <option key={v} value={v}>
                {t(`idle.saver.${v}`)}
              </option>
            ))}
          </Select>
        </label>
        {toggle("ui_sounds", t("sounds.setting"))}
        {toggle("startup_intro", t("designs.intro"), t("designs.intro_hint"))}
        <label className="block px-3.5 py-3">
          <span className="block font-medium">{t("designs.motion")}</span>
          <Select className="mt-2 sm:w-72" value={s.calm_motion ? "calm" : "on"} onChange={(e) => onChange({ calm_motion: e.target.value === "calm" })} data-testid="tv-own-calm" aria-label={t("designs.motion")}>
            <option value="on">{t("designs.motion.on")}</option>
            <option value="calm">{t("designs.motion.calm")}</option>
          </Select>
        </label>
        <label className="block px-3.5 py-3">
          <span className="block font-medium">{t("settings.language")}</span>
          <span className="mt-0.5 block text-xs text-muted">{t("devset.tv.language_hint")}</span>
          <Select className="mt-2 sm:w-72" value={s.language} onChange={(e) => onChange({ language: e.target.value as Locale })} data-testid="tv-own-language" aria-label={t("settings.language")}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </Select>
        </label>
        {toggle("health_report", t("health.setting"), t("health.setting_hint"))}
        {toggle("slow_hint", t("tvplay.row.slow_hint"), t("tvplay.row.slow_hint_hint"))}
        {toggle("show_prebuffer", t("pstats.row.prebuffer"), t("pstats.row.prebuffer_hint"))}
        {toggle("speedtest", t("tvplay.net.row"), t("tvplay.net.row_hint"))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">{t("devset.tv.quality")}</span>
        <DevicePrefsButton deviceId={deviceId} name={name} />
      </div>
    </Card>
  );
}
