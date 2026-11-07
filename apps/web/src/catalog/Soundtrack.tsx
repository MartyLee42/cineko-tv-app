import type { MediaDetail } from "@martytv/contracts";
import { soundtrackUrl, useI18n } from "@martytv/ui";
import { EXTRA_CHIP } from "./Trivia";

/**
 * «Послушать саундтрек»: Cineko Music (a separate app, full page load)
 * makes or reuses the playlist of the title's music and opens it.
 */
export function SoundtrackButton({ m }: { m: Pick<MediaDetail, "id"> }) {
  const { t, locale } = useI18n();
  return (
    <a
      href={soundtrackUrl("", m.id, locale)}
      data-testid="soundtrack-button"
      className={EXTRA_CHIP}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9 17.5V6.2a1 1 0 0 1 .76-.97l9-2.25A1 1 0 0 1 20 3.95v11.3a3 3 0 1 1-2-2.83V7.03l-7 1.75v8.72A3 3 0 1 1 9 17.5z" />
      </svg>
      {t("soundtrack.listen")}
    </a>
  );
}
