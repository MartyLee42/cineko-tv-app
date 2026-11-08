// Phone remote → the «Видео» player: which playback command does what. Pure
// (the player's controls are injected), so the mapping is unit-tested.
import type { PlayerCommand, VideoPlayRequest } from "../remote/commands";
import type { VideoControls, VideoSession } from "./session";

/**
 * Runs a playback command on the YouTube player: pause / resume / seek /
 * stop as for films, next_episode = «Следующее видео» (the first playable
 * related one), set_audio = an auto-dub's language (the TV reports
 * video.audio_tracks). Sources and subtitle tracks don't apply.
 */
export function videoControl(cmd: PlayerCommand, vc: VideoControls | null, close: () => void): true | "failed" | "unsupported" {
  if (cmd.type === "stop") {
    close();
    return true;
  }
  switch (cmd.type) {
    case "pause":
      return vc ? vc.pause() || "failed" : "failed";
    case "resume":
      return vc ? vc.resume() || "failed" : "failed";
    case "seek":
      return vc ? vc.seek(cmd.position_seconds) || "failed" : "failed";
    case "next_episode":
      return vc ? vc.next() || "failed" : "failed";
    case "set_audio":
      return vc ? vc.audio(cmd.track_id) || "failed" : "failed";
    default:
      return "unsupported";
  }
}

/**
 * video.play for the video already on screen with a quality: switch the
 * quality in place (the phone's quality select) instead of starting over.
 * null = not that case (a normal video.play).
 */
export function qualityInPlace(req: VideoPlayRequest, cur: VideoSession | null, vc: VideoControls | null): boolean | null {
  if (!cur || !vc || cur.video.id !== req.video_id || !req.quality) return null;
  return vc.quality(req.quality);
}
