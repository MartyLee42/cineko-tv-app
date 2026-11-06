import { describe, expect, it } from "vitest";
import { defaultEpisode, defaultVariant, groupBySource, onlineOnly, sortedQualities, variantEpisodes } from "./onlineWatch";
import type { OnlineList, OnlineVariant } from "./sourcesApi";

const prov = {
  cvh: { id: "cdnvideohub", name: "CDNVideoHub", kind: "online" as const },
  col: { id: "collaps", name: "Collaps", kind: "online" as const },
  ani: { id: "anilibria", name: "AniLiberty", kind: "anime" as const },
};

function v(id: string, provider: OnlineVariant["provider"], o: Partial<OnlineVariant> = {}): OnlineVariant {
  return {
    id,
    provider,
    voice: id,
    voiceover: { kind: null, studio: id, language: "ru" },
    title: null,
    max_quality: 1080,
    qualities: [1080, 720],
    format: "mp4",
    subtitle_langs: [],
    season: null,
    episode: null,
    episodes: [],
    preferred: false,
    score: 0.5,
    ...o,
  };
}

const list = (items: OnlineVariant[]): OnlineList => ({ items, providers: [], searched_at: "2026-10-29T00:00:00Z", cached: false });

describe("online watch helpers", () => {
  it("keeps only online (not anime) variants", () => {
    expect(onlineOnly(list([v("a", prov.ani), v("b", prov.cvh)])).map((x) => x.id)).toEqual(["b"]);
    expect(onlineOnly(undefined)).toEqual([]);
  });

  it("groups by source in ranking order, preferred voice first", () => {
    const items = [v("c1", prov.col), v("v1", prov.cvh), v("c2", prov.col, { preferred: true }), v("v2", prov.cvh)];
    const g = groupBySource(items);
    expect(g.map((x) => x.provider.id)).toEqual(["collaps", "cdnvideohub"]);
    expect(g[0]!.variants.map((x) => x.id)).toEqual(["c2", "c1"]);
    expect(g[1]!.variants.map((x) => x.id)).toEqual(["v1", "v2"]);
  });

  it("picks the preferred variant, else the first", () => {
    expect(defaultVariant([v("a", prov.cvh), v("b", prov.col, { preferred: true })])?.id).toBe("b");
    expect(defaultVariant([v("a", prov.cvh), v("b", prov.col)])?.id).toBe("a");
    expect(defaultVariant([])).toBeNull();
  });

  it("chooses the episode: next up when the voice has it, else the first", () => {
    const s = v("s", prov.cvh, { season: 1, episodes: [3, 1, 2, 2] });
    expect(variantEpisodes(s)).toEqual([1, 2, 3]);
    expect(defaultEpisode(s, 2)).toBe(2);
    expect(defaultEpisode(s, 9)).toBe(1);
    expect(defaultEpisode(v("e", prov.cvh, { episode: 5 }), null)).toBe(5);
    expect(defaultEpisode(null, 1)).toBeNull();
  });

  it("sorts qualities best first", () => {
    expect(sortedQualities([480, 2160, 720, 480])).toEqual([2160, 720, 480]);
  });
});
