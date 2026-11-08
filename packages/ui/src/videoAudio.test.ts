import { afterEach, describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { messagesRu } from "./locales/all.ru";
import { audioLabel, audioLangName, audioOptions, parseAudioPref, prefForTrack, resolveAudio, videoAudioPref } from "./videoAudio";

// The server's order: VIDEO_LANG (ru dub), the original, then the rest.
const tracks = [
  { id: "ru", language: "ru", original: false },
  { id: "en", language: "en", original: true },
  { id: "pt-br", language: "pt-br", original: false },
  { id: "ja", language: "ja", original: false },
];
const ru = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => {
  const s = (messagesRu as Record<string, string>)[k] ?? k;
  return s.replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? ""));
};

describe("audio track list", () => {
  it("puts the original first and marks the playing track", () => {
    const o = audioOptions(tracks, "ru");
    expect(o.map((x) => x.id)).toEqual(["en", "ru", "pt-br", "ja"]);
    expect(o.filter((x) => x.selected).map((x) => x.id)).toEqual(["ru"]);
    // No audio_track yet: the server plays the first.
    expect(audioOptions(tracks, null).find((x) => x.selected)?.id).toBe("ru");
  });

  it("is empty for a single track", () => {
    expect(audioOptions([tracks[1]!], "en")).toEqual([]);
    expect(audioOptions(undefined, null)).toEqual([]);
  });

  it("labels original and dubs in Russian", () => {
    expect(audioLabel(tracks[1]!, ru, "ru")).toBe("Оригинал · Английский");
    expect(audioLabel(tracks[0]!, ru, "ru")).toBe("Русский дубляж");
    expect(audioLangName("pt-br", ru, "ru")).toBe("Португальский (BR)");
    expect(audioLabel({ language: "", original: true }, ru, "ru")).toBe("Оригинал");
    // Not in the table: Intl's name where the engine has it, else the code.
    expect(["Суахили", "SW"]).toContain(audioLangName("sw", ru, "ru"));
  });
});

describe("audio preference", () => {
  it("remembers the original as such, dubs by language", () => {
    expect(prefForTrack(tracks[1]!)).toBe("original");
    expect(prefForTrack(tracks[2]!)).toBe("pt-br");
  });

  it("resolves like the server", () => {
    expect(resolveAudio(tracks, "original")?.id).toBe("en");
    expect(resolveAudio(tracks, "ja")?.id).toBe("ja");
    expect(resolveAudio(tracks, "pt")?.id).toBe("pt-br"); // base language
    expect(resolveAudio(tracks, "de")?.id).toBe("ru"); // missing: the default
    expect(resolveAudio(tracks, null)?.id).toBe("ru");
    expect(resolveAudio([{ id: "de", language: "de", original: false }], "original")?.id).toBe("de");
    expect(resolveAudio([], "ru")).toBeNull();
  });

  it("accepts only valid stored values", () => {
    expect(parseAudioPref("original")).toBe("original");
    expect(parseAudioPref("pt-br")).toBe("pt-br");
    expect(parseAudioPref("../x")).toBeNull();
    expect(parseAudioPref(42)).toBeNull();
  });
});

describe("device storage", () => {
  afterEach(() => videoAudioPref.set(null));
  it("keeps the choice for the session without localStorage", () => {
    // vitest runs in node: no localStorage → no crash, kept in memory.
    videoAudioPref.set("ru");
    expect(videoAudioPref.get()).toBe("ru");
    videoAudioPref.set(null);
    expect(videoAudioPref.get()).toBeNull();
  });
});
