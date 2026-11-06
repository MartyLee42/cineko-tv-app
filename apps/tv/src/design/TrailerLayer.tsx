import { useEffect, useRef } from "react";
import type { Schemas } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";

type Video = Schemas["Video"];

/** Embed URL for a trailer (no-cookie YouTube / Vimeo), autoplaying. */
export function trailerUrl(v: Video): string {
  return v.site === "Vimeo" ? `https://player.vimeo.com/video/${encodeURIComponent(v.key)}?autoplay=1` : `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.key)}?autoplay=1&rel=0`;
}

/** Full-screen trailer over Details; Back/Stop closes it. */
export function TrailerLayer({ video, onClose }: { video: Video; onClose: () => void }) {
  const { t } = useI18n();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (k !== "back" && k !== "stop") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, []);
  return (
    <div data-testid="trailer" className="fixed left-0 top-0 z-40 h-[1080px] w-[1920px] bg-black">
      <iframe title={video.name} src={trailerUrl(video)} allow="autoplay; fullscreen" className="h-full w-full border-0" />
      <p className="absolute bottom-6 right-10 rounded-xl bg-black/70 px-5 py-2 text-[20px] text-white/80">{t("common.back")}</p>
    </div>
  );
}
