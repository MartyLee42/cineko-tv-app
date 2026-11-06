import { describe, expect, it } from "vitest";
import { hasAudio } from "./audio";

const v = (o: Record<string, unknown>) => o as unknown as HTMLVideoElement;

describe("hasAudio", () => {
  it("flags silence only when the browser is decoding video itself", () => {
    expect(hasAudio(v({ webkitVideoDecodedByteCount: 5000, webkitAudioDecodedByteCount: 0 }))).toBe(false);
    expect(hasAudio(v({ webkitVideoDecodedByteCount: 5000, webkitAudioDecodedByteCount: 800 }))).toBe(true);
  });
  it("trusts nothing on hardware pipelines (both counters 0)", () => {
    expect(hasAudio(v({ webkitVideoDecodedByteCount: 0, webkitAudioDecodedByteCount: 0 }))).toBe(true);
  });
  it("ignores a lone audio counter and empty audioTracks", () => {
    expect(hasAudio(v({ webkitAudioDecodedByteCount: 0 }))).toBe(true);
    expect(hasAudio(v({ audioTracks: { length: 0 } }))).toBe(true);
  });
  it("uses mozHasAudio when present", () => {
    expect(hasAudio(v({ mozHasAudio: false }))).toBe(false);
  });
});
