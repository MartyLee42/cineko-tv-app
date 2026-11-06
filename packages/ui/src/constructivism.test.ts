import { describe, expect, it } from "vitest";
import {
  CV_SLOGANS,
  firstSloganIndex,
  nextSloganIndex,
  pickLeninInOctober,
  readLeninCache,
  writeLeninCache,
} from "./constructivism";
import { findFilms, normTitle, pickByTitle } from "./cvSearch";
import { CV_GLYPHS } from "./cvIcons";
import { CV_MESSAGES, translate, translateCv } from "./i18n";
import {
  CV_MENU,
  CV_NEWS,
  cvMenuLabel,
  filmsRu,
  finishedThisYear,
  hasQualityMark,
  isDeficit,
  newlyFinished,
  planOf,
  queuePlace,
  queueText,
  stakhanovets,
  takeNewlyFinished,
  takeQueueTurn,
  udarnikLabel,
  weekStart,
  type HistLike,
} from "./cvExtras";
import { getAppliedDesign, setAppliedDesign } from "./designs";

/** A deterministic "random" that returns the given values in turn. */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length]!;
};

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe("slogans", () => {
  it("has ~15–20 family-friendly lines about cinema", () => {
    expect(CV_SLOGANS.length).toBeGreaterThanOrEqual(15);
    expect(CV_SLOGANS.length).toBeLessThanOrEqual(20);
    expect(new Set(CV_SLOGANS).size).toBe(CV_SLOGANS.length);
    expect(CV_SLOGANS).toContain("Важнейшим из искусств для нас является кино!");
  });

  it("first slogan follows the injected random", () => {
    expect(firstSloganIndex(10, () => 0)).toBe(0);
    expect(firstSloganIndex(10, () => 0.55)).toBe(5);
    expect(firstSloganIndex(10, () => 0.9999999)).toBe(9);
    expect(firstSloganIndex(10, () => NaN)).toBe(0);
    expect(firstSloganIndex(1, () => 0.7)).toBe(0);
  });

  it("next slogan is random but never repeats the current one", () => {
    expect(nextSloganIndex(0, 5, () => 0)).toBe(1);
    expect(nextSloganIndex(4, 5, () => 0)).toBe(0);
    expect(nextSloganIndex(2, 5, () => 0.999)).toBe(1);
    expect(nextSloganIndex(0, 1, () => 0.5)).toBe(0);
    const rand = seq(0.1, 0.5, 0.9, 0.3, 0.7, 0.05);
    let i = 0;
    for (let k = 0; k < 200; k++) {
      const n = nextSloganIndex(i, CV_SLOGANS.length, rand);
      expect(n).not.toBe(i);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(CV_SLOGANS.length);
      i = n;
    }
  });
});

// The real search result of «Ленин в Октябре» (kind=movie, lang=ru) on the dev stack.
const LENIN_RESULTS = [
  { id: "a", kind: "movie", tmdb_id: 204802, title: "Ленин в Октябре", original_title: "Ленин в Октябре", year: 1937 },
  { id: "b", kind: "movie", tmdb_id: 218141, title: "Ленин в октябре", original_title: "Lenin in October", year: 2010 },
];

describe("«Ленин в Октябре» lookup", () => {
  it("picks the 1937 film, whatever the order", () => {
    expect(pickLeninInOctober(LENIN_RESULTS)?.tmdb_id).toBe(204802);
    expect(pickLeninInOctober([...LENIN_RESULTS].reverse())?.tmdb_id).toBe(204802);
  });

  it("falls back to the oldest exact title; ignores series and other films", () => {
    expect(pickLeninInOctober([LENIN_RESULTS[1]!, { ...LENIN_RESULTS[0]!, year: 1938, id: "c" }])?.id).toBe("c");
    expect(pickLeninInOctober([{ ...LENIN_RESULTS[0]!, kind: "series" }])).toBeNull();
    expect(pickLeninInOctober([{ id: "x", kind: "movie", title: "Ленин в 1918 году", original_title: "Ленин в 1918 году", year: 1939 }])).toBeNull();
    expect(pickLeninInOctober([])).toBeNull();
    expect(pickLeninInOctober(undefined)).toBeNull();
  });

  it("matches the English title too", () => {
    expect(pickLeninInOctober([{ id: "e", kind: "movie", title: "Lenin in October", original_title: "Ленин в Октябре", year: 1937 }])?.id).toBe("e");
  });

  it("caches per language with a TTL", () => {
    const s = mem();
    writeLeninCache("ru", { id: "a" }, 1000, s);
    expect(readLeninCache<{ id: string }>("ru", 2000, s)?.id).toBe("a");
    expect(readLeninCache("en", 2000, s)).toBeNull();
    expect(readLeninCache("ru", 1000 + 31 * 24 * 3600_000, s)).toBeNull();
    s.setItem("martytv.cv.lenin", "{broken");
    expect(readLeninCache("ru", 2000, s)).toBeNull();
  });
});

describe("«Госкино» search", () => {
  const r = (id: string, title: string, year: number, kind = "movie", original_title = title) => ({ id, kind, title, original_title, year });

  it("normalises titles", () => {
    expect(normTitle("Ирония судьбы, или С лёгким паром!")).toBe("ирония судьбы или с легким паром");
    expect(normTitle("Операция «Ы»")).toBe("операция ы");
  });

  it("picks the exact title near the year, then a prefix match", () => {
    expect(pickByTitle([r("1", "Бриллиантовая рука", 1968)], "Бриллиантовая рука", 1968)?.id).toBe("1");
    expect(pickByTitle([r("2", "Кавказская пленница, или Новые приключения Шурика", 1967)], "Кавказская пленница", 1967)?.id).toBe("2");
    expect(pickByTitle([r("3", "Служебный роман. Наше время", 2011)], "Служебный роман", 1977)).toBeNull();
    expect(pickByTitle([r("4", "Брат", 1997)], "Афоня", 1975)).toBeNull();
    expect(pickByTitle([r("5", "Гостья из будущего", 1985, "series")], "Гостья из будущего", 1984)).toBeNull();
  });

  it("finds the list in order, skipping failures and duplicates", async () => {
    const list = [
      { q: "Москва слезам не верит", year: 1979 },
      { q: "Сломано", year: 1970 },
      { q: "Нет такого", year: 1970 },
      { q: "Москва слезам не верит", year: 1979 },
    ];
    const films = await findFilms(list, async (q) => {
      if (q === "Сломано") throw new Error("503");
      return q === "Москва слезам не верит" ? [r("m", q, 1979)] : [];
    });
    expect(films.map((f) => f.id)).toEqual(["m"]);
  });
});

const h = (id: string, at: string | null, completed = true, title = id): HistLike => ({ media: { id, title, kind: "movie" }, progress: { completed, completed_at: at } });

describe("the five-year plan", () => {
  const now = new Date(2026, 10, 1, 12); // Sun 1 Nov 2026

  it("counts titles finished this year", () => {
    const items = [h("a", new Date(2026, 0, 5).toISOString()), h("b", new Date(2025, 11, 31).toISOString()), h("c", null, false), h("d", new Date(2026, 9, 1).toISOString()), h("a", new Date(2026, 1, 1).toISOString())];
    const p = planOf(items, now);
    expect(p).toEqual({ year: 2026, done: 2, target: 60, pct: 3 });
    expect(finishedThisYear(items, now).map((x) => x.id)).toEqual(["a", "d"]);
  });

  it("week starts on Monday", () => {
    expect(weekStart(now).getDate()).toBe(26); // Mon 26 Oct
    expect(weekStart(new Date(2026, 9, 26, 0, 1)).getDate()).toBe(26);
  });

  it("names the week's stakhanovets", () => {
    const thisWeek = new Date(2026, 9, 28).toISOString();
    const lastWeek = new Date(2026, 9, 20).toISOString();
    const res = stakhanovets(
      [
        { name: "Анна", items: [h("1", thisWeek), h("2", thisWeek), h("3", lastWeek)] },
        { name: "Петя", items: [h("4", thisWeek), h("5", lastWeek), h("6", lastWeek)] },
      ],
      now,
    );
    expect(res).toEqual({ name: "Анна", count: 2 });
    expect(stakhanovets([{ name: "Никто", items: [h("1", lastWeek)] }], now)).toBeNull();
    expect(filmsRu(1)).toBe("фильм");
    expect(filmsRu(3)).toBe("фильма");
    expect(filmsRu(7)).toBe("фильмов");
    expect(filmsRu(12)).toBe("фильмов");
    expect(filmsRu(22)).toBe("фильма");
  });

  it("toasts each finish once, never on the first look", () => {
    expect(newlyFinished(null, [{ id: "a", title: "A" }])).toEqual([]);
    const s = mem();
    expect(takeNewlyFinished("p", [{ id: "a", title: "A" }], 2026, s)).toEqual([]);
    expect(takeNewlyFinished("p", [{ id: "a", title: "A" }, { id: "b", title: "B" }], 2026, s)).toEqual([{ id: "b", title: "B" }]);
    expect(takeNewlyFinished("p", [{ id: "a", title: "A" }, { id: "b", title: "B" }], 2026, s)).toEqual([]);
  });
});

describe("ratings, queue, menu", () => {
  it("«ударник» and «Знак качества»", () => {
    expect(udarnikLabel(8.66)).toBe("ударник ★8,7");
    expect(udarnikLabel(9)).toBe("ударник ★9");
    expect(udarnikLabel(8.5, "en")).toBe("ударник ★8.5");
    expect(udarnikLabel(7.9)).toBeNull();
    expect(udarnikLabel(null)).toBeNull();
    expect(hasQualityMark([null, 8.5])).toBe(true);
    expect(hasQualityMark([8.4, 8.49])).toBe(false);
    expect(hasQualityMark([undefined, null])).toBe(false);
  });

  it("the queue: popular titles, place 2–5, once per title per session", () => {
    expect(isDeficit({ vote_count: 20000, rating: 8.1 })).toBe(true);
    expect(isDeficit({ vote_count: 200, rating: 8.1 })).toBe(false);
    expect(queuePlace(() => 0)).toBe(2);
    expect(queuePlace(() => 0.999)).toBe(5);
    expect(queuePlace(() => 0.5)).toBe(4);
    expect(queueText(3)).toBe("Вы 3-й в очереди за дефицитом…");
    const s = mem();
    expect(takeQueueTurn("m1", s)).toBe(true);
    expect(takeQueueTurn("m1", s)).toBe(false);
    expect(takeQueueTurn("m2", s)).toBe(true);
  });

  it("menu labels only in this design", () => {
    expect(cvMenuLabel(true, "home", "Главная")).toBe("Главк");
    expect(cvMenuLabel(true, "settings", "Настройки")).toBe("Политбюро");
    expect(cvMenuLabel(true, "movies", "Фильмы")).toBe("Фильмы");
    expect(cvMenuLabel(false, "home", "Главная")).toBe("Главная");
    expect(Object.values(CV_MENU)).toContain("Розыск");
    expect(CV_NEWS.length).toBeGreaterThanOrEqual(12);
  });

  it("applyDesign's store", () => {
    setAppliedDesign("constructivism");
    expect(getAppliedDesign()).toBe("constructivism");
    setAppliedDesign(null);
    expect(getAppliedDesign()).toBeNull();
  });
});

describe("«Товарищ ЭВМ» and the pictograms", () => {
  it("renames the AI in this design only", () => {
    expect(cvMenuLabel(true, "ask", "Спросить ИИ")).toBe("Товарищ ЭВМ");
    expect(translateCv("ru", "ask.title")).toBe("Спросите Товарища ЭВМ");
    expect(translateCv("ru", "ask.thinking")).toBe("Товарищ ЭВМ думает…");
    expect(translateCv("ru", "ask.subtitle")).toMatch(/электронный советчик Госкино/i);
    expect(translateCv("ru", "catalog.ai.mode")).toBe("ЭВМ");
    expect(translateCv("ru", "catalog.ai.suggest", { q: "x" })).toBe("Спросить Товарища ЭВМ: «x»");
    expect(translateCv("en", "ask.title")).toBe("Ask Comrade Computer");
    // Keys it does not rename, and the plain translation, stay as they were.
    expect(translateCv("ru", "ask.send")).toBe(translate("ru", "ask.send"));
    expect(translate("ru", "ask.title")).toBe("Спросить ИИ");
    for (const l of ["ru", "en"] as const) for (const v of Object.values(CV_MESSAGES[l])) expect(v).toBeTruthy();
  });

  it("has a filled pictogram for every glyph", () => {
    for (const [name, g] of Object.entries(CV_GLYPHS)) expect(g, name).toBeTruthy();
    expect(Object.keys(CV_GLYPHS).length).toBeGreaterThanOrEqual(50);
  });
});
