import { describe, expect, it } from "vitest";
import { MATCH_GENERIC, matchInfoOf, matchLoader } from "./loaderMatch";
import { LoaderPick } from "./loaderPick";

const info = (text: string, genre_ids: number[] = [], id = "m1") => ({ id, text, genre_ids });

describe("«Под фильм» loading style", () => {
  it("themes in the text or keywords come first (en and ru)", () => {
    expect(matchLoader(info("A hacker discovers the world is a simulation"))).toBe("matrix");
    expect(matchLoader(info("Хакер узнаёт, что мир — виртуальная реальность"))).toBe("matrix");
    expect(matchLoader(info("A teenager is sent back in time in a time machine"))).toBe("speed88");
    expect(matchLoader(info("Подросток отправляется в прошлое на машине времени"))).toBe("speed88");
    expect(matchLoader(info("An astronaut stranded in outer space", [18]))).toBe("odyssey");
    expect(matchLoader(info("Экипаж космического корабля встречает инопланетян"))).toBe("odyssey");
    expect(matchLoader(info("A lazy cat and his owner", [35]))).toBe("paws");
    expect(matchLoader(info("Приключения кота в большом городе"))).toBe("paws");
    expect(matchLoader({ id: "x", keywords: ["time travel"], genre_ids: [35] })).toBe("speed88");
  });

  it("no false themes inside other words", () => {
    // «workspace», «alienation», «котлета» are not space / aliens / cats.
    expect(matchLoader(info("A workspace drama about alienation", [18]))).not.toMatch(/odyssey/);
    expect(matchLoader(info("Повар готовит котлеты", [35]))).toBe("popcorn");
  });

  it("then genres", () => {
    expect(["balloons", "aquarium"]).toContain(matchLoader(info("", [16, 35])));
    expect(["balloons", "aquarium"]).toContain(matchLoader(info("", [10751])));
    expect(matchLoader(info("", [27]))).toBe("minimal");
    expect(matchLoader(info("", [53, 80]))).toBe("minimal");
    expect(matchLoader(info("", [878]))).toBe("odyssey");
    expect(matchLoader(info("", [35]))).toBe("popcorn");
    expect(["film_reel", "poster_reveal"]).toContain(matchLoader(info("", [99])));
    expect(["film_reel", "poster_reveal"]).toContain(matchLoader(info("", [18])));
  });

  it("else a stable pick per title among the generic styles", () => {
    const a = matchLoader({ id: "tt-1" });
    expect(MATCH_GENERIC).toContain(a);
    expect(matchLoader({ id: "tt-1" })).toBe(a);
    const picks = new Set(Array.from({ length: 40 }, (_, i) => matchLoader({ id: `id-${i}` })));
    expect(picks.size).toBeGreaterThan(3);
    expect(matchLoader(null)).toBe("popcorn");
  });

  it("builds its input from a MediaDetail (genres or genre_ids) or nothing", () => {
    expect(matchInfoOf("m", undefined)).toEqual({ id: "m" });
    const i = matchInfoOf("m", { kind: "movie", genres: [{ id: 878 }], title: "Interstellar", overview: "Explorers travel through a wormhole in space" });
    expect(i.genre_ids).toEqual([878]);
    expect(matchLoader(i)).toBe("odyssey");
    expect(matchInfoOf("m", { genre_ids: [35] }).genre_ids).toEqual([35]);
  });

  it("resolves once per attempt, even if the title's details arrive later", () => {
    const pick = new LoaderPick();
    let calls = 0;
    const get = () => (calls++, info("Hacker", [], "m1"));
    expect(pick.resolve("match", "load|1", get)).toBe("matrix");
    expect(pick.resolve("match", "load|1", () => info("cats", [], "m1"))).toBe("matrix");
    expect(calls).toBe(1);
    expect(pick.resolve("match", "load|2", () => info("A cat", [], "m2"))).toBe("paws");
  });
});
