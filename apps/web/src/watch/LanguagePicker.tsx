// The interface language in the PWA. Precedence (packages/ui localeDetect.ts):
// this browser's own pick > the active profile's ui_language > the browser's
// language. Picking here sets both this browser's choice and the profile's
// ui_language, so the profile's other new devices open in it too.
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { LOCALE_NAMES, LOCALES, useI18n, type Locale } from "@martytv/ui";
import { api } from "../api";
import { Select } from "../components";
import type { Preferences } from "../play/prefs";
import { useActiveProfile } from "./ActiveProfile";

const prefsKey = (id: string) => ["profile-prefs", id] as const;

/** Applies the active profile's ui_language once its preferences load (mount once, inside ActiveProfileProvider). */
export function ProfileLanguage() {
  const id = useActiveProfile().profile?.id ?? "";
  const { setProfileLocale } = useI18n();
  const q = useQuery({
    queryKey: prefsKey(id),
    queryFn: () => unwrap(api.GET("/profiles/{id}/preferences", { params: { path: { id } } })),
    enabled: id !== "",
    staleTime: 5 * 60_000,
  });
  const lang = q.data?.ui_language;
  useEffect(() => {
    if (lang !== undefined) setProfileLocale(lang);
  }, [lang, setProfileLocale]);
  return null;
}

/** The language select + what it changes (Settings, the first-run guide). */
export function LanguagePicker({ className, testId }: { className?: string; testId?: string }) {
  const { t, locale, setLocale, setProfileLocale, clearDeviceLocale, deviceLocale, profileLocale } = useI18n();
  const { profile } = useActiveProfile();
  const qc = useQueryClient();
  const pick = (l: Locale) => {
    setLocale(l);
    if (!profile) return;
    const id = profile.id;
    void unwrap(api.PATCH("/profiles/{id}/preferences", { params: { path: { id } }, body: { ui_language: l } })).then(
      (p) => {
        qc.setQueryData<Preferences>(prefsKey(id), p);
        setProfileLocale(p.ui_language);
      },
      () => undefined, // a shared profile (not ours) or offline: this browser keeps the pick
    );
  };
  // Another device changed the profile's language; this browser kept its own.
  const differs = !!profile && !!deviceLocale && !!profileLocale && profileLocale !== locale;
  return (
    <div>
      <Select value={locale} onChange={(e) => pick(e.target.value as Locale)} className={className} data-testid={testId}>
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </Select>
      <p className="mt-1.5 text-xs leading-relaxed text-muted" data-testid="language-scope">
        {profile ? t("uilang.hint.profile", { name: profile.name }) : t("uilang.hint.browser")}
      </p>
      {differs && profileLocale && (
        <p className="mt-1 text-xs text-muted">
          {t("uilang.profile_differs", { name: profile.name, lang: LOCALE_NAMES[profileLocale] })}{" "}
          <button type="button" onClick={clearDeviceLocale} className="min-h-[32px] font-semibold text-accent" data-testid="language-follow-profile">
            {t("uilang.follow_profile")}
          </button>
        </p>
      )}
    </div>
  );
}
