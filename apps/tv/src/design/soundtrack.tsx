// «Саундтрек на телефоне»: the TV has no music player, so the details' More
// menu shows a QR code of the Cineko Music page that makes (or reuses) the
// title's soundtrack playlist on the phone. Back / OK closes.
import { useEffect, useState } from "react";
import { soundtrackUrl, Spinner, useI18n } from "@martytv/ui";
import { qrDataUrl } from "../screens/qr";
import { usePanelKeys } from "./trivia";

export function SoundtrackPanel({ mediaId, title, onClose }: { mediaId: string; title: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const url = soundtrackUrl(location.origin, mediaId, locale);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    qrDataUrl(url, { margin: 1, width: 400, errorCorrectionLevel: "M" })
      .then((d) => live && setQr(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  usePanelKeys((k, e) => {
    if (k === "back" || k === "stop" || (k === "ok" && !e.repeat)) onClose();
  });
  return (
    <div data-testid="tv-soundtrack-panel" className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] items-center justify-center bg-black/70">
      <div className="flex w-[1400px] items-center rounded-card bg-surface px-16 py-14 shadow-2xl">
        <div className="mr-16 flex h-[424px] w-[424px] shrink-0 items-center justify-center rounded-2xl bg-white p-3">
          {qr ? <img src={qr} alt="" width={400} height={400} /> : <Spinner size={64} />}
        </div>
        <div className="min-w-0">
          <h2 className="text-5xl font-bold leading-tight">♫ {t("soundtrack.tv_title", { title })}</h2>
          <p className="mt-8 text-[34px] leading-snug text-muted">{t("soundtrack.tv_hint")}</p>
          <span className="tv-focus is-focused mt-12 inline-block rounded-2xl bg-accent px-10 py-5 text-3xl font-semibold text-on-accent">{t("common.close")} · OK</span>
        </div>
      </div>
    </div>
  );
}
