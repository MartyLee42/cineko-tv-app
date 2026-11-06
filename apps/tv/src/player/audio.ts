/**
 * False only when we're sure the file's audio isn't being decoded. TV engines
 * (Tizen, webOS, MSX) often hand the file to a hardware pipeline where the
 * browser's decode counters stay 0 although sound plays fine, so the audio
 * counter is trusted only when the video counter shows the browser itself is
 * decoding. Anything uncertain counts as "has audio" (never stop playback on
 * a guess).
 */
export function hasAudio(v: HTMLVideoElement): boolean {
  const x = v as unknown as { webkitAudioDecodedByteCount?: number; webkitVideoDecodedByteCount?: number; mozHasAudio?: boolean };
  if (typeof x.webkitAudioDecodedByteCount === "number" && typeof x.webkitVideoDecodedByteCount === "number") {
    return !(x.webkitVideoDecodedByteCount > 0 && x.webkitAudioDecodedByteCount === 0);
  }
  if (typeof x.mozHasAudio === "boolean") return x.mozHasAudio;
  return true;
}
