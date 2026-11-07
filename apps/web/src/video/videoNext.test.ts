import { describe, expect, it } from "vitest";
import { nextInSeries, pickNextVideo, seriesPart, type NextVideoCandidate } from "@martytv/media-types";

const v = (id: string, title: string, o: Partial<NextVideoCandidate> = {}): NextVideoCandidate => ({ id, title, channel_id: "ch", live: false, upcoming: false, short: false, ...o });

describe("seriesPart", () => {
  it("reads part numbers in Russian and English", () => {
    expect(seriesPart("Строим дом — Часть 3")).toEqual({ stem: "строим дом часть #", n: 3 });
    expect(seriesPart("Строим дом — Часть 4")?.stem).toBe(seriesPart("Строим дом — Часть 3")?.stem);
    expect(seriesPart("Minecraft Hardcore Episode 12: The End")?.n).toBe(12);
    expect(seriesPart("Летсплей #7 | Лес")?.n).toBe(7);
    expect(seriesPart("3 серия. Финал")?.n).toBe(3);
    expect(seriesPart("Show S02E05 recap")).toMatchObject({ n: 5 });
    expect(seriesPart("Show S02E05 recap")?.stem).not.toBe(seriesPart("Show S03E06 recap")?.stem); // other season
    expect(seriesPart("Top 10 cats of 2024")).toBeNull();
    expect(seriesPart("iPhone 15 review")).toBeNull();
  });
});

describe("next video", () => {
  const cur = v("a", "Строим дом — Часть 3");
  it("continues a series on the same channel", () => {
    const rel = [v("x", "Something else"), v("b", "Строим дом — Часть 5"), v("c", "Строим дом — Часть 4"), v("d", "Строим дом — Часть 4", { channel_id: "other" })];
    expect(nextInSeries(cur, rel)?.id).toBe("c");
    expect(pickNextVideo(cur, rel)).toEqual({ video: rel[2], why: "series" });
    // Not in related: the channel's list.
    expect(pickNextVideo(cur, [v("x", "Other")], [v("e", "Строим дом — Часть 4")])?.video.id).toBe("e");
    // A skipped part: the next number above.
    expect(nextInSeries(cur, [v("f", "Строим дом — Часть 6")])?.id).toBe("f");
  });
  it("else a random related one, unwatched first, no Shorts / live / recent", () => {
    const rel = [
      v("s", "Short", { short: true }),
      v("l", "Live", { live: true }),
      v("w", "Watched", { progress: { position_seconds: 95, duration_seconds: 100, finished: false } }),
      v("r1", "Fresh one"),
      v("r2", "Fresh two"),
    ];
    const plain = v("p", "Just a video");
    expect(pickNextVideo(plain, rel, [], { random: () => 0 })).toEqual({ video: rel[3], why: "random" });
    expect(pickNextVideo(plain, rel, [], { random: () => 0.99 })?.video.id).toBe("r2");
    expect(pickNextVideo(plain, rel, [], { random: () => 0, recent: new Set(["r1", "r2"]) })?.video.id).toBe("w");
    expect(pickNextVideo(plain, [v("s", "Short", { short: true })])).toBeNull();
  });
});
