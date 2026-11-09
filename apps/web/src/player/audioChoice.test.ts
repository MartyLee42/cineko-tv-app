import { beforeEach, describe, expect, it } from "vitest";
import type { MediaInfo } from "@martytv/contracts";
import {
  audioLanguages,
  audioNeedsSwitch,
  audioPosition,
  chooseAudio,
  defaultAudioIndex,
  normLang,
  readAudioChoice,
  writeAudioChoice,
} from "./audioChoice";

type Track = MediaInfo["audio"][number];
const tr = (index: number, language: string | null, title: string | null, def = false, codec = "ac3"): Track => ({ index, codec, language, title, channels: 6, default: def });
const info = (...audio: Track[]): MediaInfo => ({ container: "matroska,webm", video_codec: "h264", width: 1920, height: 1080, duration_seconds: 7200, audio, subtitles: [] });

// An English-default release with two Russian voices (typical BDRip).
const film = info(tr(1, "eng", null, true), tr(2, "rus", "Дубляж"), tr(3, "rus", "MVO LostFilm"));

describe("audio choice", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  });

  it("normalizes languages", () => {
    expect(normLang("rus")).toBe("ru");
    expect(normLang("ru-RU")).toBe("ru");
    expect(normLang("und")).toBeNull();
    expect(normLang(null)).toBeNull();
  });

  it("knows the default track", () => {
    expect(defaultAudioIndex(film)).toBe(1);
    expect(defaultAudioIndex(info(tr(4, "rus", null), tr(5, "eng", null)))).toBe(4);
    expect(defaultAudioIndex(null)).toBeNull();
  });

  it("prefers the profile's language over the file's default", () => {
    expect(chooseAudio(film, { languages: ["ru"] })).toEqual({ index: 2, reason: "language" });
    expect(chooseAudio(film, { languages: ["en", "ru"] })).toEqual({ index: 1, reason: "language" });
    expect(chooseAudio(film, { languages: ["de"] })).toEqual({ index: 1, reason: "default" });
    expect(chooseAudio(film)).toEqual({ index: 1, reason: "default" });
    expect(chooseAudio(info())).toBeNull();
  });

  it("voice-over studios beat languages; the remembered pick beats both", () => {
    expect(chooseAudio(film, { voiceovers: ["lostfilm"], languages: ["ru"] })).toEqual({ index: 3, reason: "voiceover" });
    const mem = { language: "eng", title: null };
    expect(chooseAudio(film, { voiceovers: ["lostfilm"], languages: ["ru"] }, mem)).toEqual({ index: 1, reason: "remembered" });
    // Another release of the title: same voice by name, else by language.
    const other = info(tr(1, "rus", "Дубляж", true), tr(2, "rus", "MVO LostFilm"), tr(3, "eng", null));
    expect(chooseAudio(other, {}, { language: "rus", title: "MVO LostFilm" })?.index).toBe(2);
    expect(chooseAudio(other, {}, { language: "rus", title: "Кубик в Кубе" })?.index).toBe(1);
    expect(chooseAudio(other, {}, { language: "eng", title: null })?.index).toBe(3);
  });

  it("switches streams only when the browser can't and the pick isn't the default", () => {
    const ru = chooseAudio(film, { languages: ["ru"] });
    expect(audioNeedsSwitch(film, ru, false)).toBe(true);
    expect(audioNeedsSwitch(film, ru, true)).toBe(false); // Safari: audioTracks
    expect(audioNeedsSwitch(film, chooseAudio(film, { languages: ["en"] }), false)).toBe(false);
    expect(audioNeedsSwitch(film, chooseAudio(film), false)).toBe(false);
    expect(audioNeedsSwitch(null, null, false)).toBe(false);
  });

  it("maps stream indexes to audioTracks positions", () => {
    expect(audioPosition(film, 3)).toBe(2);
    expect(audioPosition(film, 9)).toBe(-1);
  });

  it("falls back to the UI language", () => {
    expect(audioLanguages(["en"], "ru")).toEqual(["en"]);
    expect(audioLanguages([], "ru")).toEqual(["ru"]);
    expect(audioLanguages(null, "kk")).toEqual(["kk"]);
  });

  it("remembers the pick per title", () => {
    expect(readAudioChoice("m1")).toBeNull();
    writeAudioChoice("m1", { language: "rus", title: "MVO LostFilm" });
    expect(readAudioChoice("m1")).toEqual({ language: "rus", title: "MVO LostFilm" });
    expect(readAudioChoice("m2")).toBeNull();
    writeAudioChoice(null, { language: "eng", title: null });
    expect(readAudioChoice(null)).toBeNull();
    localStorage.setItem("martytv.audio_choice", "junk");
    expect(readAudioChoice("m1")).toBeNull();
  });

  it("keeps the newest 200 titles", () => {
    for (let i = 0; i < 205; i++) writeAudioChoice(`m${i}`, { language: "rus", title: null }, i);
    expect(readAudioChoice("m0")).toBeNull();
    expect(readAudioChoice("m4")).toBeNull();
    expect(readAudioChoice("m5")).not.toBeNull();
    expect(readAudioChoice("m204")).not.toBeNull();
  });
});
