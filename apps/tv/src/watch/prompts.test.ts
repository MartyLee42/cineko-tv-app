import { describe, expect, it } from "vitest";
import type { Message } from "@martytv/contracts";
import { MessageQueue, parseMessageEvent } from "../messages/queue";
import { isCompleted, MAX_SERIES_SKIPS, RatingQueue, starsToRating, type KV, type RateItem } from "./rating";

function kv(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

const movie: RateItem = { profile_id: "p", media_id: "m1", episode_id: null, kind: "movie", title: "M", poster_path: null };
const ep = (n: number): RateItem => ({ profile_id: "p", media_id: "s1", episode_id: `e${n}`, kind: "series", title: "S", poster_path: null });

describe("rating prompt rules", () => {
  it("completion threshold", () => {
    expect(isCompleted(5400, 6000, "movie")).toBe(true);
    expect(isCompleted(5830, 6000, "movie")).toBe(true);
    expect(isCompleted(3000, 6000, "movie")).toBe(false);
    expect(isCompleted(2550, 2700, "series")).toBe(true);
    expect(isCompleted(100, null, "movie")).toBe(false);
  });

  it("a movie is asked once (remembered across restarts)", () => {
    const store = kv();
    const q = new RatingQueue(store);
    expect(q.offer(movie)).toBe(true);
    q.skip(movie);
    expect(q.pending).toBeNull();
    expect(new RatingQueue(store).offer(movie)).toBe(false);
  });

  it("not asked when already rated", () => {
    const q = new RatingQueue(kv());
    expect(q.offer(movie, true)).toBe(false);
    q.offer(ep(1));
    q.rated(ep(1));
    expect(q.offer(ep(2))).toBe(false);
  });

  it("series: once per episode, stops after repeated 'Not now'", () => {
    const q = new RatingQueue(kv());
    expect(q.offer(ep(1))).toBe(true);
    q.shown(ep(1));
    expect(q.offer(ep(1))).toBe(false);
    for (let i = 1; i <= MAX_SERIES_SKIPS; i++) {
      q.offer(ep(i));
      q.skip(ep(i));
    }
    expect(q.offer(ep(10))).toBe(false);
  });

  it("latest completed item wins the pending slot", () => {
    const q = new RatingQueue(kv());
    q.offer(ep(1));
    q.offer(ep(2));
    expect(q.pending?.episode_id).toBe("e2");
  });

  it("ten stars are the 1..10 rating", () => {
    expect([1, 5, 8, 10, 11].map(starsToRating)).toEqual([1, 5, 8, 10, 10]);
  });
});

const msg = (id: string, p: Partial<Message> = {}): Message => ({ id, title: `T${id}`, body: "b", from_name: "Admin", created_at: "2026-10-01T00:00:00Z", read_at: null, ...p });

describe("message queue", () => {
  it("FIFO, deduplicated, read messages skipped", () => {
    const q = new MessageQueue();
    expect(q.add(msg("a"))).toBe(true);
    expect(q.add(msg("a"))).toBe(false);
    expect(q.add(msg("r", { read_at: "2026-10-02T00:00:00Z" }))).toBe(false);
    q.add(msg("b"));
    expect(q.current?.id).toBe("a");
    expect(q.size).toBe(2);
    q.dismiss("a");
    expect(q.current?.id).toBe("b");
  });

  it("each message shows once per run, even if re-sent", () => {
    const q = new MessageQueue();
    q.add(msg("a"));
    q.dismiss("a");
    expect(q.add(msg("a"))).toBe(false);
    expect(q.current).toBeNull();
  });

  it("startup inbox (newest first) is shown oldest first", () => {
    const q = new MessageQueue();
    q.addAll([msg("new"), msg("old")]);
    expect(q.current?.id).toBe("old");
  });

  it("validates realtime payloads", () => {
    expect(parseMessageEvent(null)).toBeNull();
    expect(parseMessageEvent({ id: "x", title: 1 })).toBeNull();
    expect(parseMessageEvent({ id: "x", title: "Hi", body: "there" })).toMatchObject({ id: "x", title: "Hi", from_name: "", read_at: null });
  });
});
