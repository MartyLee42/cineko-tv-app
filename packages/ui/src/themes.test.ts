import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "./i18n";
import { reasonText, rowTitle } from "./foryou";

const ru = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);
const en = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);
const base = { text: "server", media_title: null, person_name: null, genre_names: [] as string[], collection_title: null, mood: null };

describe("themes and AI reasons", () => {
  it("prefers the AI's personal line over any typed reason", () => {
    const r = { ...base, type: "because_you_rated", media_title: "Сталкер", ai_text: "Медленный, как любимый вами Тарковский" };
    expect(reasonText(r, ru)).toBe("✦ Медленный, как любимый вами Тарковский");
    expect(reasonText({ ...r, ai_text: null }, ru)).toBe("Потому что вам понравился «Сталкер»");
  });

  it("names a liked theme, by grammar when translated", () => {
    const r = { ...base, type: "theme", keyword_name: "ограбления", keyword_localized: true, genre_names: ["криминал"] };
    expect(reasonText(r, ru)).toBe("Вам нравятся фильмы про ограбления");
    expect(reasonText({ ...r, keyword_name: "heist", keyword_localized: false }, ru)).toBe("Ваша тема: heist");
    expect(reasonText({ ...r, keyword_name: "heist" }, en)).toBe("A theme you love: heist");
    // Unknown keyword: the genres it also carries.
    expect(reasonText({ ...r, keyword_name: null }, ru)).toContain("криминал");
    expect(rowTitle({ kind: "theme", title: "srv", reason: r }, ru)).toBe("Вам нравятся фильмы про ограбления");
    expect(rowTitle({ kind: "theme", title: "srv", reason: { ...r, keyword_name: null } }, ru)).toBe("srv");
  });
});
