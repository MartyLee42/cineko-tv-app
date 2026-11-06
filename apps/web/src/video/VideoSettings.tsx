// Settings → profile: «Качество видео» (video_quality: the maximum YouTube
// height, 720 by default). Sits in the profile's toggle list next to
// «Скрывать Shorts».
import { useI18n } from "@martytv/ui";
import { qualityLabel } from "./logic";

export const VIDEO_QUALITIES = [480, 720, 1080] as const;
export type VideoQualitySetting = (typeof VIDEO_QUALITIES)[number];

export function VideoQualityRow({ value, onChange }: { value: number; onChange: (q: VideoQualitySetting) => void }) {
  const { t } = useI18n();
  return (
    <label className="flex items-center gap-4 px-3.5 py-3">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{t("video.settings.quality")}</span>
        <span className="mt-0.5 block text-xs text-muted">{t("video.settings.quality_hint")}</span>
      </span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as VideoQualitySetting)}
        className="min-h-[40px] rounded-lg border border-border bg-bg px-2.5 text-text"
        data-testid="setting-video-quality"
      >
        {VIDEO_QUALITIES.map((q) => (
          <option key={q} value={q}>
            {qualityLabel(q)}
          </option>
        ))}
      </select>
    </label>
  );
}
