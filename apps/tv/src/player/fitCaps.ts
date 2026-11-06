// This TV's capabilities for the release fit chips («✓ Пойдёт», «✗ Видео
// HEVC не поддерживается»…, @martytv/media-types fit.ts): the same probe the
// TV reports to the server as PlaybackAuto, so the TV and a phone sending to
// it judge a release alike. The TV also knows a few codecs the report has no
// field for (XviD, MPEG-2, AVI): added from its own probe.
import { capsFromAuto, type AutoLike, type DeviceCaps } from "@martytv/media-types";
import { detectAuto } from "../settings/devicePrefs";
import { assessRelease, assessSource, engineProbe, type Probe } from "./codecs";
import { compatPrefStore } from "./compat";

/** Extra keys the PlaybackAuto enums don't carry (judged by fit.ts when present). */
function extras(probe: Probe): { video: string[]; containers: string[] } {
  const video: string[] = [];
  for (const [key, name] of [
    ["mpeg4", "xvid"],
    ["mpeg2", "mpeg2"],
  ] as const) {
    if (assessRelease({ video_codec: name, audio_codecs: [] }, probe).parts.some((p) => p.kind === "video" && p.ok === true)) video.push(key);
  }
  const avi = assessSource({ mime_type: "video/x-msvideo", media_info: null }, probe).parts.some((p) => p.kind === "container" && p.ok === true);
  return { video, containers: avi ? ["avi"] : [] };
}

/**
 * Capabilities from this TV's detected auto profile (codecs, containers,
 * screen, compat) and its probe. `compatOff`: «Совместимый звук» = Выкл —
 * the server's AAC conversion isn't used here.
 */
export function tvCaps(auto: AutoLike, probe: Probe, compatOff = false): DeviceCaps {
  const caps = capsFromAuto(auto, null);
  const x = extras(probe);
  // Extras only refine a known list (an empty one stays «unknown»).
  return {
    ...caps,
    video: caps.video?.length ? [...caps.video, ...x.video] : caps.video,
    containers: caps.containers?.length ? [...caps.containers, ...x.containers] : caps.containers,
    compat: !!caps.compat && !compatOff,
  };
}

/** This TV now (its engine probe, screen, compat setting). */
export function thisTvCaps(probe: Probe = engineProbe()): DeviceCaps {
  return tvCaps(detectAuto(probe), probe, compatPrefStore.get() === "off");
}
