import assert from "node:assert/strict";
import { test } from "node:test";
import type { Track } from "../src/api.ts";
import {
  allPreview,
  canSave,
  currentSource,
  itemTrack,
  providersFor,
  sourceMenu,
  sourceQuery,
  sourceTabs,
  torrentQuery,
  youtubeItems,
  zaycevItems,
} from "../src/sources.ts";

const ALL = { youtube: true, torrents: true };

// The same song as it shows up in each list of the app.
const catalog: Track = { id: "dz:3135556", title: "Harder, Better, Faster, Stronger", artist: "Daft Punk", artistId: 27, album: "Discovery", albumId: 302127, duration: 224 };
const contexts: Record<string, Track> = {
  "search / album / chart": catalog,
  "album played from a torrent": { ...catalog, src: { hash: "a".repeat(40), file: 3, ext: "flac", lossless: true } },
  "imported or AI playlist": { id: "yq:0123456789abcdef0123", title: "Группа крови", artist: "Кино", duration: 285 },
  "YouTube search result": { id: "yt:dQw4w9WgXcQ", title: "Never Gonna Give You Up", artist: "Rick Astley", duration: 213 },
  "Zaycev search result": { id: "zv:4521", title: "Звезда", artist: "Кино", duration: 0 },
  "torrent file": { id: `t:${"b".repeat(40)}:2`, title: "One", artist: "Metallica", duration: 446, src: { hash: "b".repeat(40), file: 2, ext: "mp3" } },
};

test("every list offers the same source entries (no more torrents-only playlist menu)", () => {
  const want = sourceMenu(catalog, ALL);
  assert.deepEqual(want.map((m) => m.tab), ["all", "torrents"]);
  for (const [name, t] of Object.entries(contexts)) {
    assert.deepEqual(sourceMenu(t, ALL), want, name);
    assert.deepEqual(providersFor(t, ALL), ["zaycev", "youtube", "torrents"], name);
  }
});

test("providers follow the server's features", () => {
  assert.deepEqual(providersFor(catalog, { youtube: false, torrents: false }), ["zaycev"]);
  assert.deepEqual(sourceMenu(catalog, { youtube: true, torrents: false }).map((m) => m.tab), ["all"]);
  // Before /me answers: YouTube and zaycev (the usual setup), trackers once known.
  assert.deepEqual(providersFor(catalog, undefined), ["zaycev", "youtube"]);
  assert.deepEqual(sourceMenu({ id: "yq:x", title: " " }, ALL), []);
});

test("the choice is remembered for catalog and imported tracks only", () => {
  assert.equal(canSave(contexts["search / album / chart"]!), true);
  assert.equal(canSave(contexts["imported or AI playlist"]!), true);
  assert.equal(canSave(contexts["YouTube search result"]!), false);
  assert.equal(canSave(contexts["torrent file"]!), false);
});

test("sourceQuery names the track", () => {
  const q = new URLSearchParams(sourceQuery(contexts["imported or AI playlist"]!));
  assert.equal(q.get("id"), "yq:0123456789abcdef0123");
  assert.equal(q.get("artist"), "Кино");
  assert.equal(q.get("duration"), "285");
  assert.equal(q.get("album"), null);
  assert.equal(new URLSearchParams(sourceQuery(catalog)).get("album"), "Discovery");
});

test("currentSource", () => {
  assert.deepEqual(currentSource(catalog, "zv:9"), { provider: "zaycev", value: "zv:9" });
  assert.deepEqual(currentSource(catalog, "abcdefghijk"), { provider: "youtube", value: "abcdefghijk" });
  assert.equal(currentSource(catalog, ""), null);
  assert.equal(currentSource(catalog, "abc", { hash: "c".repeat(40), file: 1, ext: "flac" })?.provider, "torrents");
  assert.equal(currentSource(contexts["album played from a torrent"]!, "")?.provider, "torrents");
  assert.deepEqual(currentSource(contexts["YouTube search result"]!, ""), { provider: "youtube", value: "dQw4w9WgXcQ" });
  assert.deepEqual(currentSource(contexts["Zaycev search result"]!, ""), { provider: "zaycev", value: "zv:4521" });
});

const yt = youtubeItems(
  [
    { videoId: "v1", title: "Daft Punk - Harder", author: "Daft Punk - Topic", duration: 224, views: 1, score: 90 },
    { videoId: "v2", title: "Live", author: "x", duration: 300, views: 1, score: 50 },
    { videoId: "v3", title: "Cover", author: "y", duration: 220, views: 1, score: 40 },
    { videoId: "v4", title: "Remix", author: "z", duration: 250, views: 1, score: 30 },
  ],
  "v4",
);
const zv = zaycevItems([{ id: "zv:1", title: "Harder", artist: "Daft Punk", duration: 224, bitrate: 320, score: 95 }], "v4");

test("items carry the provider, the value to store and the current mark", () => {
  assert.equal(yt[3]!.current, true);
  assert.equal(yt[0]!.current, false);
  assert.equal(zv[0]!.sub, "Daft Punk · 320 кбит/с");
  assert.equal(zv[0]!.value, "zv:1");
});

test("tabs: counts, per-tab loading / error, the current source marked", () => {
  const tabs = sourceTabs(["zaycev", "youtube", "torrents"], {
    zaycev: { status: "ok", count: 1 },
    youtube: { status: "loading", count: 0 },
    torrents: { status: "idle", count: 0 },
  }, "zaycev");
  assert.deepEqual(tabs.map((t) => [t.id, t.label, t.count, t.loading, t.current]), [
    ["all", "Все", 1, true, false],
    ["zaycev", "Zaycev", 1, false, true],
    ["youtube", "YouTube", null, true, false],
    ["torrents", "Торренты", null, false, false],
  ]);
  const err = sourceTabs(["zaycev", "youtube"], { zaycev: { status: "error", count: 0 }, youtube: { status: "ok", count: 4 } }, null);
  assert.deepEqual(err.map((t) => [t.id, t.count, t.error]), [["all", 4, false], ["zaycev", null, true], ["youtube", 4, false]]);
  assert.equal(sourceTabs(["zaycev"], {}, null)[0]!.count, null);
});

test("«Все» previews the best few per provider and keeps the current one", () => {
  const prev = allPreview({ zaycev: zv, youtube: yt });
  assert.deepEqual(prev.map((i) => i.value), ["zv:1", "v4", "v1", "v2"]);
  assert.deepEqual(allPreview({ youtube: yt }, 2).map((i) => i.value), ["v4", "v1"]);
});

test("a one-off choice plays as a YouTube / zaycev track", () => {
  const t = itemTrack(contexts["torrent file"]!, yt[0]!);
  assert.equal(t.id, "yt:v1");
  assert.equal(t.src, undefined);
  assert.equal(t.title, "One");
  assert.equal(itemTrack(catalog, zv[0]!).id, "zv:1");
});

test("torrent search: by album when known", () => {
  assert.deepEqual(torrentQuery(catalog), { artist: "Daft Punk", album: "Discovery" });
  assert.deepEqual(torrentQuery({ artist: "Кино, Цой", title: "Звезда" }), { text: "Кино Звезда" });
});
