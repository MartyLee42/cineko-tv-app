import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "./i18n";
import {
  dedupeHistory,
  EMPTY_SURPRISE,
  groupByMonth,
  historyLines,
  historyView,
  isFiltered,
  matchesHistory,
  monthLabel,
  quizGenSummary,
  reasonText,
  rowTitle,
  surpriseRequest,
  toggleIn,
  visibleRows,
  withoutMedia,
  type HistoryLike,
  type ReasonLike,
} from "./foryou";

const ru = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);
const en = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);

const reason = (p: Partial<ReasonLike>): ReasonLike => ({
  type: "popular",
  text: "server text",
  media_title: null,
  person_name: null,
  genre_names: [],
  collection_title: null,
  mood: null,
  ...p,
});

describe("reasonText", () => {
  it("builds localized text from typed fields, not the server text", () => {
    expect(reasonText(reason({ type: "because_you_rated", media_title: "Матрица", text: "Because you liked The Matrix" }), ru)).toBe(
      "Потому что вам понравился «Матрица»",
    );
    expect(reasonText(reason({ type: "director", person_name: "Дени Вильнёв" }), ru)).toBe("Режиссёр — Дени Вильнёв");
    expect(reasonText(reason({ type: "actor", person_name: "Keanu Reeves" }), en)).toBe("Starring Keanu Reeves");
    expect(reasonText(reason({ type: "genre", genre_names: ["драма", "триллер", "комедия"] }), ru)).toBe("Ваши жанры: драма, триллер");
    expect(reasonText(reason({ type: "genre" }), ru)).toBe("В ваших любимых жанрах");
    expect(reasonText(reason({ type: "hidden_gem" }), en)).toMatch(/hidden gem/i);
    expect(reasonText(reason({ type: "mood", mood: "cozy" }), ru)).toBe("Под настроение: Уютное");
    expect(reasonText(reason({ type: "ai_collection", collection_title: "Нуар" }), ru)).toBe("Из подборки «Нуар»");
    expect(reasonText(reason({ type: "rewatch" }), en)).toBe("A favourite worth rewatching");
  });

  it("falls back to the server text for unknown types or missing fields", () => {
    expect(reasonText(reason({ type: "because_you_rated" }), ru)).toBe("server text");
    expect(reasonText(reason({ type: "brand_new" }), ru)).toBe("server text");
  });
});

describe("rowTitle", () => {
  it("names rows from kind + reason", () => {
    const r = (kind: string, p: Partial<ReasonLike> = {}) => ({ kind, title: "Server title", reason: reason(p) });
    expect(rowTitle(r("because_you_rated", { media_title: "Матрица" }), ru)).toBe("Потому что вам понравился «Матрица»");
    expect(rowTitle(r("director", { person_name: "Кристофер Нолан" }), ru)).toBe("Ещё от режиссёра Кристофер Нолан");
    expect(rowTitle(r("hidden_gems"), ru)).toBe("Скрытые жемчужины");
    expect(rowTitle(r("top_picks"), en)).toBe("Picked for you");
    expect(rowTitle(r("ai_collection", { collection_title: "Кино для дождливого вечера" }), ru)).toBe("Подборка: Кино для дождливого вечера");
    expect(rowTitle(r("director"), ru)).toBe("Server title");
  });
});

describe("rows", () => {
  const row = (id: string, kind: string, ids: string[]) => ({ id, kind, items: ids.map((x) => ({ media: { id: x } })) });
  it("hides the cold-start popular row and empty rows", () => {
    const rows = [row("popular", "popular", ["a"]), row("tp", "top_picks", []), row("hg", "hidden_gems", ["b"])];
    expect(visibleRows(rows, true).map((r) => r.id)).toEqual(["hg"]);
    expect(visibleRows(rows, false).map((r) => r.id)).toEqual(["popular", "hg"]);
  });
  it("removes a dismissed title everywhere and drops emptied rows", () => {
    const rows = [row("a", "top_picks", ["x", "y"]), row("b", "genre", ["x"])];
    const out = withoutMedia(rows, "x");
    expect(out.map((r) => r.id)).toEqual(["a"]);
    expect(out[0]!.items.map((i) => i.media.id)).toEqual(["y"]);
    expect(withoutMedia(rows, "zzz")[0]).toBe(rows[0]);
  });
});

const h = (id: string, at: string, p: { kind?: string; rating?: number | null; title?: string; completed?: boolean } = {}): HistoryLike => ({
  media: { id, kind: p.kind ?? "movie", title: p.title ?? `Title ${id}`, original_title: `Orig ${id}`, me: { rating: p.rating ?? null } },
  progress: { completed: p.completed ?? true, completed_at: p.completed === false ? null : at, updated_at: at, episode_id: null },
});

describe("history", () => {
  const items = [
    h("1", "2026-10-28T10:00:00Z", { rating: 9, title: "Ёлки" }),
    h("2", "2026-10-02T10:00:00Z", { kind: "series" }),
    h("2", "2026-10-01T10:00:00Z", { kind: "series" }),
    h("3", "2026-09-30T23:00:00Z", { completed: false }),
    h("4", "2019-01-05T10:00:00Z", { rating: 7 }),
  ];

  it("groups by month (UTC) in order", () => {
    const g = groupByMonth(items);
    expect(g.map((x) => [x.key, x.items.length])).toEqual([
      ["2026-10", 3],
      ["2026-09", 1],
      ["2019-01", 1],
    ]);
    expect(monthLabel("2026-10", ru)).toBe("Октябрь 2026");
    expect(monthLabel("2019-01", en)).toBe("January 2019");
  });

  it("keeps the newest entry per title", () => {
    expect(dedupeHistory(items).map((x) => x.media.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("filters by kind, rating and search (ё = е, original title)", () => {
    const ids = (f: Parameters<typeof matchesHistory>[1]) => items.filter((x) => matchesHistory(x, f)).map((x) => x.media.id);
    expect(ids({ kind: "rated", q: "" })).toEqual(["1", "4"]);
    expect(ids({ kind: "series", q: "" })).toEqual(["2", "2"]);
    expect(ids({ kind: "movie", q: "" })).toEqual(["1", "3", "4"]);
    expect(ids({ kind: "all", q: "елки" })).toEqual(["1"]);
    expect(ids({ kind: "all", q: "orig 4" })).toEqual(["4"]);
    expect(isFiltered({ kind: "all", q: "  " })).toBe(false);
    expect(isFiltered({ kind: "rated", q: "" })).toBe(true);
  });

  it("flattens groups into month headers + items", () => {
    const lines = historyLines(historyView(items, { kind: "all", q: "" }));
    expect(lines.map((l) => (l.type === "month" ? `#${l.key}:${l.count}` : l.item.media.id))).toEqual(["#2026-10:2", "1", "2", "#2026-09:1", "3", "#2019-01:1", "4"]);
  });
});

describe("surpriseRequest", () => {
  it("sends only the filters that are set", () => {
    expect(surpriseRequest(EMPTY_SURPRISE, "p1")).toEqual({ profile_id: "p1", kind: "movie" });
  });
  it("maps every field", () => {
    const body = surpriseRequest(
      { mood: "cozy", genres: [35, 18], runtime: "medium", decade: 1990, minRating: 7, includeWatched: true, kind: "any" },
      "p1",
      ["a", "b"],
    );
    expect(body).toEqual({
      profile_id: "p1",
      kind: "any",
      mood: "cozy",
      genres: [35, 18],
      runtime_min: 90,
      runtime_max: 150,
      decade: 1990,
      min_rating: 7,
      include_watched: true,
      exclude_ids: ["a", "b"],
    });
    expect(surpriseRequest({ ...EMPTY_SURPRISE, runtime: "short" }, "p").runtime_max).toBe(90);
    expect(surpriseRequest({ ...EMPTY_SURPRISE, runtime: "long" }, "p")).toMatchObject({ runtime_min: 150 });
    expect(surpriseRequest({ ...EMPTY_SURPRISE, runtime: "long" }, "p").runtime_max).toBeUndefined();
  });
  it("caps exclude_ids to the last 200", () => {
    const ex = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const body = surpriseRequest(EMPTY_SURPRISE, "p", ex);
    expect(body.exclude_ids).toHaveLength(200);
    expect(body.exclude_ids![0]).toBe("id50");
  });
  it("toggles chips", () => {
    expect(toggleIn([1, 2], 2)).toEqual([1]);
    expect(toggleIn([1], 3)).toEqual([1, 3]);
  });
});

describe("quizGenSummary", () => {
  it("names the liked and disliked genres", () => {
    const r = { basis: { titles: 42 }, state: { answers: { genres_like: ["35", "878"], genres_dislike: ["27"] } } };
    expect(quizGenSummary(r, ru)).toBe("Готово! Учли ваши фильмы и сериалы: 42. Любимые жанры: комедии, фантастика. Не ваше: ужасы.");
    expect(quizGenSummary({ basis: { titles: 3 }, state: { answers: {} } }, en)).toBe("Done! Based on your films and series: 3.");
  });
});
