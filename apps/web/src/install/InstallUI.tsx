import { useState } from "react";
import { createPortal } from "react-dom";
import { Mascot, useI18n } from "@martytv/ui";
import { Button } from "../components";
import { CloseIcon } from "../icons";
import { Sheet } from "../remote/SendToTv";
import { cameFromTv } from "../watch/fromTv";
import { bannerDismissed, dismissBanner, offerInstall, promptInstall, useInstall } from "./install";

/** iOS: Safari has no install prompt — show the two taps. */
function IosSteps({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet title={t("install.ios_title")} onClose={onClose}>
      <ol className="space-y-4 text-sm" data-testid="install-ios-steps">
        <li className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent font-bold text-on-accent">1</span>
          <span>
            {t("install.ios_step1")}{" "}
            <svg viewBox="0 0 24 24" width="18" height="18" className="inline -mt-1 text-accent" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent font-bold text-on-accent">2</span>
          <span>{t("install.ios_step2")}</span>
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent font-bold text-on-accent">3</span>
          <span>{t("install.ios_step3")}</span>
        </li>
      </ol>
      <Button className="mt-5 w-full" onClick={onClose}>
        {t("install.got_it")}
      </Button>
    </Sheet>
  );
}

/** Starts the install: the browser dialog, or the iOS steps. */
export function useStartInstall() {
  const s = useInstall();
  const [ios, setIos] = useState(false);
  const start = () => {
    if (s.canPrompt) void promptInstall();
    else if (s.platform === "ios") setIos(true);
  };
  const steps = ios ? createPortal(<IosSteps onClose={() => setIos(false)} />, document.body) : null;
  // Inside Media Station X (iPad hand-off) there is no «Add to Home Screen».
  return { offer: offerInstall(s) && !cameFromTv(), start, steps };
}

/** A one-time, dismissible banner at the bottom (above the phone tab bar). */
export function InstallBanner() {
  const { t } = useI18n();
  const { offer, start, steps } = useStartInstall();
  const [hidden, setHidden] = useState(bannerDismissed);
  if (!offer || hidden) return steps;
  const close = () => {
    dismissBanner();
    setHidden(true);
  };
  return (
    <>
      {createPortal(
        <div
          data-testid="install-banner"
          className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex items-center gap-3 rounded-2xl border border-border bg-surface p-3 shadow-2xl shadow-black/40 md:bottom-6 md:left-auto md:right-6 md:w-96"
        >
          <Mascot className="h-10 w-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("install.banner_title")}</p>
            <p className="text-xs text-muted">{t("install.banner_body")}</p>
          </div>
          <Button
            className="min-h-0 shrink-0 py-2 text-sm"
            onClick={() => {
              start();
              close();
            }}
          >
            {t("install.action")}
          </Button>
          <button type="button" aria-label={t("install.dismiss")} onClick={close} className="shrink-0 text-muted hover:text-text">
            <CloseIcon />
          </button>
        </div>,
        document.body,
      )}
      {steps}
    </>
  );
}
