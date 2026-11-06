// A short volume indicator on the TV when a phone changed the level
// («🔊 60 %» / «Звук выключен»). Over every screen and player; animated with
// transform/opacity only (cheap on TV GPUs). The TV's own volume buttons show
// the TV's own OSD, so only remote changes show this.
import { useEffect, useState } from "react";
import { useI18n } from "@martytv/ui";
import { tvVolume, type AudioLevel } from "./volume";

const SHOW_MS = 2200;

export function VolumeOsd() {
  const { t } = useI18n();
  const [level, setLevel] = useState<AudioLevel | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = tvVolume.subscribe((remote) => {
      if (!remote) return;
      setLevel(tvVolume.level());
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), SHOW_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);

  if (!level) return null;
  const pct = Math.round(level.volume * 100);
  const silent = level.muted;
  return (
    <div
      data-testid="tv-volume-osd"
      data-visible={visible ? "1" : "0"}
      data-volume={pct}
      data-muted={level.muted ? "1" : "0"}
      aria-live="polite"
      className="pointer-events-none absolute right-16 top-14 z-50 w-[420px] rounded-3xl bg-surface-2/95 px-9 py-6 shadow-2xl transition-[opacity,transform] duration-200 ease-out"
      style={{ opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(-24px)" }}
    >
      <p className="text-[40px] font-semibold tabular-nums">{silent ? `🔇 ${t("remote.tv.volume_muted")}` : `🔊 ${pct} %`}</p>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-200"
          style={{ transform: `scaleX(${silent ? 0 : level.volume})` }}
        />
      </div>
    </div>
  );
}
