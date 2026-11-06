import { describe, expect, it } from "vitest";
import { langName, normLang, pickPreferredAudio, trackLabel, voiceoverLabel } from "./tracks";

describe("track labels", () => {
  it("language name + studio title", () => {
    expect(trackLabel({ language: "rus", title: "LostFilm", codec: "ac3", channels: 6 }, 0)).toBe("Русский · LostFilm");
    expect(trackLabel({ language: "eng", title: "Original" }, 1)).toBe("English · Original");
  });
  it("engine label wins; a label that is just the language is dropped", () => {
    expect(trackLabel({ language: "ru", title: "x" }, 0, "HDRezka Studio")).toBe("Русский · HDRezka Studio");
    expect(trackLabel({ language: "ru", codec: "aac", channels: 2 }, 0, "Русский")).toBe("Русский · AAC 2.0");
    // A language-only engine label must not hide the studio from ffprobe.
    expect(trackLabel({ language: "rus", title: "MovieDalen", codec: "ac3", channels: 6 }, 0, "rus")).toBe("Русский · MovieDalen");
    expect(trackLabel({ language: "rus", title: "LostFilm" }, 0, "Russian")).toBe("Русский · LostFilm");
    expect(trackLabel({ language: "eng", title: "English", codec: "eac3", channels: 6 }, 1, "eng")).toBe("English · E-AC3 5.1");
    expect(trackLabel({ language: "en" }, 0, "eng")).toBe("English");
  });
  it("falls back to codec or #n", () => {
    expect(trackLabel({ language: "und", codec: "dts", channels: 6 }, 0)).toBe("DTS 5.1");
    expect(trackLabel({}, 2)).toBe("#3");
  });
  it("normalises languages", () => {
    expect(normLang("RUS")).toBe("ru");
    expect(normLang("en-US")).toBe("en");
    expect(normLang("und")).toBeNull();
    expect(langName("xx")).toBe("XX");
  });
});

describe("pickPreferredAudio", () => {
  const tracks = [
    { label: "Original", language: "eng" },
    { label: "Дубляж", language: "rus" },
    { label: "MVO LostFilm", language: "rus" },
    { label: "HDRezka Studio", language: "rus" },
  ];
  it("first preferred studio, case-insensitive, in preference order", () => {
    expect(pickPreferredAudio(tracks, { voiceovers: ["lostfilm", "HDRezka"] })).toBe(2);
    expect(pickPreferredAudio(tracks, { voiceovers: ["Кубик в Кубе", "hdrezka"] })).toBe(3);
  });
  it("else the first track in the most preferred language", () => {
    expect(pickPreferredAudio(tracks, { voiceovers: ["Jaskier"], languages: ["ru", "en"] })).toBe(1);
    expect(pickPreferredAudio(tracks, { languages: ["en"] })).toBe(0);
  });
  it("null when nothing matches", () => {
    expect(pickPreferredAudio(tracks, { voiceovers: [], languages: ["de"] })).toBeNull();
    expect(pickPreferredAudio([], { voiceovers: ["x"] })).toBeNull();
  });
});

describe("voice-over chips", () => {
  it("kind · studio", () => {
    expect(voiceoverLabel({ kind: "mvo", studio: "LostFilm", language: "ru" })).toBe("MVO · LostFilm");
    expect(voiceoverLabel({ kind: "dub", studio: null, language: "ru" })).toBe("Dub");
    expect(voiceoverLabel({ kind: null, studio: "Гаврилов", language: "ru" })).toBe("Гаврилов");
    expect(voiceoverLabel({ kind: null, studio: null, language: "ru" })).toBeNull();
  });
});
