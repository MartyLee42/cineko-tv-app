import { useState } from "react";
import type { Profile } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { OptionRows, useOptionKeys, type Row } from "./OptionList";
import { LoaderPreview, useSettingRows } from "./rows";
import { SkinBackground } from "../design/skins";
import { DesignPreviews } from "../design/previews";

const STEPS = 4;

/**
 * First-run guide for a profile (until settings.onboarding_completed):
 * look & language → loading animation → playback → done. Changes apply
 * live; Finish or Skip marks the profile done (the PWA's guide counts too).
 */
export function Onboarding({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const { t } = useI18n();
  const { rows: r, settings, set } = useSettingRows();
  const [step, setStep] = useState(0);

  const finish = () => {
    set({ onboarding_completed: true });
    onDone();
  };
  const last = step === STEPS - 1;
  const actions: Row = {
    kind: "actions",
    key: `actions-${step}`,
    actions: [
      ...(step > 0 ? [{ key: "back", label: t("onboarding.back"), onPress: () => setStep(step - 1) }] : []),
      ...(!last ? [{ key: "skip", label: t("onboarding.skip"), onPress: finish }] : []),
      last
        ? { key: "finish", label: t("onboarding.finish"), primary: true, onPress: finish }
        : { key: "next", label: t("onboarding.next"), primary: true, onPress: () => setStep(step + 1) },
    ],
  };
  const content: Row[] = step === 0 ? [r.design, ...(settings.design === "kinozal" ? [r.theme] : []), r.language] : step === 1 ? [r.loading] : step === 2 ? [r.player, r.autoplay] : [];
  const rows = [...content, actions];
  const title = [t("onboarding.look"), t("onboarding.loading"), t("onboarding.playback"), t("onboarding.done_title")][step]!;

  return (
    <div data-testid="tv-onboarding" data-step={step + 1} className="absolute left-0 top-0 z-30 h-full w-full bg-bg">
      <SkinBackground dim />
      <div className="tv-scrim-left absolute left-0 top-0 h-full w-full opacity-60" />
      <div className="absolute left-[140px] top-[90px] w-[1000px]">
        <p className="text-2xl font-semibold uppercase tracking-wider text-accent">{t("onboarding.step", { n: step + 1, total: STEPS })}</p>
        {step === 0 && <p className="mt-4 text-4xl text-muted">{t("onboarding.welcome", { name: profile.name })}</p>}
        <h1 className="mt-3 text-7xl font-bold">{title}</h1>
        <p className="mt-5 text-3xl leading-snug text-muted">{last ? t("tv.onboarding.done_body") : step === 0 ? t("onboarding.intro") : ""}</p>
        <div className="mt-12">
          <Steps key={step} rows={rows} onBack={() => (step > 0 ? setStep(step - 1) : undefined)} />
        </div>
      </div>
      {step === 0 && (
        <div className="absolute left-[1200px] top-[300px]">
          <DesignPreviews current={settings.design} width={186} />
        </div>
      )}
      {step === 1 && (
        <div className="absolute left-[1200px] top-[300px]">
          <LoaderPreview key={settings.loading_style} style={settings.loading_style} width={600} />
        </div>
      )}
      <div className="absolute bottom-[60px] left-[140px] flex">
        {Array.from({ length: STEPS }, (_, i) => (
          <span key={i} className={`mr-3 h-3 rounded-full ${i === step ? "w-16 bg-accent" : "w-3 bg-text/25"}`} />
        ))}
        <span className="ml-8 text-xl text-muted">{t("tv.onboarding.hint")}</span>
      </div>
    </div>
  );
}

/** One step's rows (remounted per step so focus starts at the top). */
function Steps({ rows, onBack }: { rows: Row[]; onBack: () => void }) {
  const { index, action } = useOptionKeys({ rows, onBack });
  return <OptionRows rows={rows} index={index} action={action} />;
}
