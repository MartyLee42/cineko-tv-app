import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "./i18n";
import {
  awardBadgeText,
  awardBadgeTitle,
  awardGroupName,
  awardLineText,
  awardNominationCount,
  awardsByYear,
  awardsSummaryLine,
  awardWinGroups,
  moreNominationsLabel,
  nominationsLabel,
} from "./awards";

const ru = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);
const en = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);

// Parasite (2019) as GET /media/{id}?lang=ru returns it (abridged).
const parasite = [
  {
    group: "oscar",
    group_label: "Оскар",
    tier: 1,
    wins: [
      { label: "лучший фильм", year: 2020 },
      { label: "лучшая режиссёрская работа", year: 2020 },
      { label: "лучший оригинальный сценарий", year: 2020 },
    ],
    nominations: [{ label: "лучший монтаж", year: 2020 }],
  },
  { group: "cannes", group_label: "Канны", tier: 1, wins: [{ label: "Золотая пальмовая ветвь", year: 2019 }], nominations: [] },
  { group: "bafta", group_label: "BAFTA", tier: 2, wins: [{ label: "лучший оригинальный сценарий", year: 2020 }], nominations: [{ label: "лучший фильм", year: 2020 }] },
  { group: "efa", group_label: "Европейская киноакадемия", tier: 2, wins: [], nominations: [{ label: "лучший фильм", year: 2019 }] },
  { group: "other", group_label: "Другие награды", tier: 3, wins: [{ label: "Dorian Award", year: 2019 }], nominations: [] },
];

describe("awards", () => {
  it("labels the poster badge", () => {
    expect(awardBadgeText({ group: "oscar", count: 3 }, ru)).toBe("Оскар ×3");
    expect(awardBadgeText({ group: "oscar", count: 1 }, ru)).toBe("Оскар");
    expect(awardBadgeText({ group: "cannes", count: 2 }, en)).toBe("Cannes ×2");
    expect(awardBadgeTitle({ group: "berlin", count: 1 }, ru)).toBe("Награды: Берлинале ×1");
    expect(awardGroupName("venice", en)).toBe("Venice");
    expect(awardGroupName("future_award", ru)).toBe("future_award");
  });

  it("groups entries per year", () => {
    const lines = awardsByYear([
      { label: "a", year: 2019 },
      { label: "b", year: 2020 },
      { label: "c", year: 2020 },
      { label: "d", year: null },
    ]);
    expect(lines).toEqual([
      { year: 2019, labels: ["a"] },
      { year: 2020, labels: ["b", "c"] },
      { year: null, labels: ["d"] },
    ]);
    expect(awardLineText("Оскар", lines[1]!)).toBe("Оскар 2020: b, c");
    expect(awardLineText("Золотой глобус", lines[2]!)).toBe("Золотой глобус: d");
  });

  it("summarizes the major wins in one line", () => {
    expect(awardsSummaryLine(parasite)).toBe("🏆 Оскар ×3 · Канны: Золотая пальмовая ветвь · BAFTA: лучший оригинальный сценарий");
    expect(awardsSummaryLine(parasite, 2)).toBe("🏆 Оскар ×3 · Канны: Золотая пальмовая ветвь");
    expect(awardsSummaryLine(parasite.slice(3))).toBe("");
    expect(awardsSummaryLine([])).toBe("");
  });

  it("counts and labels nominations", () => {
    expect(awardWinGroups(parasite).map((g) => g.group)).toEqual(["oscar", "cannes", "bafta", "other"]);
    expect(awardNominationCount(parasite)).toBe(3);
    expect(moreNominationsLabel(1, "ru", ru)).toBe("ещё 1 номинация ▸");
    expect(moreNominationsLabel(3, "ru", ru)).toBe("ещё 3 номинации ▸");
    expect(moreNominationsLabel(5, "ru", ru)).toBe("ещё 5 номинаций ▸");
    expect(moreNominationsLabel(21, "ru", ru)).toBe("ещё 21 номинация ▸");
    expect(moreNominationsLabel(1, "en", en)).toBe("1 more nomination ▸");
    expect(moreNominationsLabel(4, "en", en)).toBe("4 more nominations ▸");
    expect(nominationsLabel(12, "ru", ru)).toBe("12 номинаций");
  });
});
