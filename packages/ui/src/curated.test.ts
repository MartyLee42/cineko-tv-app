import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "./i18n";
import { curatedGroupTitle, curatedPercent, curatedProgressLabel, orderCuratedGroups, unwatchedCurated } from "./curated";
import { rowTitle } from "./foryou";

const ru = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);
const en = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);

describe("curated lists", () => {
  it("labels progress", () => {
    expect(curatedProgressLabel(7, 48, ru)).toBe("7 из 48 просмотрено");
    expect(curatedProgressLabel(7, 48, en)).toBe("7 of 48 watched");
    expect(curatedProgressLabel(12, 48, ru, true)).toBe("12 / 48");
  });

  it("computes the watched share", () => {
    expect(curatedPercent(0, 0)).toBe(0);
    expect(curatedPercent(1, 3)).toBe(33);
    expect(curatedPercent(48, 48)).toBe(100);
    expect(curatedPercent(60, 48)).toBe(100);
  });

  it("orders groups thinkers → directors → polls → ru, unknown last", () => {
    const got = orderCuratedGroups([{ id: "ru" }, { id: "x" }, { id: "polls" }, { id: "thinkers" }, { id: "directors" }]);
    expect(got.map((g) => g.id)).toEqual(["thinkers", "directors", "polls", "ru", "x"]);
  });

  it("filters unwatched items and keeps missing ones", () => {
    const items = [
      { watched: true, media: {} },
      { watched: false, media: {} },
      { watched: false, media: null },
    ];
    expect(unwatchedCurated(items)).toHaveLength(2);
  });

  it("titles groups and the Home row", () => {
    expect(curatedGroupTitle("thinkers", ru, "?")).toBe("Мыслители и критики");
    expect(curatedGroupTitle("other", ru, "?")).toBe("?");
    const row = {
      kind: "curated",
      title: "server",
      reason: { type: "curated", text: "", media_title: null, person_name: null, genre_names: [], collection_title: null, mood: null },
      curated: { title: "Делёз: «Кино 2. Образ-время»", watched: 7, count: 48 },
    };
    expect(rowTitle(row, ru)).toBe("Подборка: Делёз: «Кино 2. Образ-время» · 7 из 48");
    expect(rowTitle({ ...row, curated: null }, ru)).toBe("server");
  });
});
