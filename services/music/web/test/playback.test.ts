import assert from "node:assert/strict";
import { test } from "node:test";
import { Starter, resolvePath, silenceWav, type AudioLike } from "../src/playback.ts";

class FakeAudio implements AudioLike {
  src = "";
  loop = false;
  plays: string[] = [];
  play() {
    this.plays.push(this.src);
    return Promise.resolve();
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SILENCE = "blob:silence";

function setup() {
  const calls = new Map<string, ReturnType<typeof deferred>>();
  const s = new Starter({
    silence: () => SILENCE,
    fetchResolve: (p) => {
      const d = deferred();
      calls.set(p, d);
      return d.promise;
    },
    timeoutMs: 1000,
  });
  return { s, calls };
}

test("resolvePath: catalog and imported tracks resolve, others don't", () => {
  assert.equal(resolvePath({ id: "dz:42", artist: "A", title: "T", duration: 1 }), "/resolve/42");
  const yq = resolvePath({ id: "yq:abc", artist: "Кино", title: "Звезда", duration: 200 });
  assert.ok(yq?.startsWith("/resolveq?"));
  assert.equal(new URLSearchParams(yq!.split("?")[1]).get("title"), "Звезда");
  assert.equal(resolvePath({ id: "yt:dQw4w9WgXcQ", artist: "", title: "x", duration: 0 }), null);
  assert.equal(resolvePath({ id: "t:abc:1", artist: "", title: "x", duration: 0 }), null);
});

test("plays silence while resolving, then the real stream on the same element", async () => {
  const { s, calls } = setup();
  const a = new FakeAudio();
  const done = s.start(a, { resolve: "/resolve/1", src: "/play/1", autoplay: true });
  // In the tap: the element plays (unlocked, the page counts as playing).
  assert.equal(a.src, SILENCE);
  assert.equal(a.loop, true);
  assert.deepEqual(a.plays, [SILENCE]);
  assert.equal(s.warm, true);
  calls.get("/resolve/1")!.resolve();
  assert.equal(await done, true);
  assert.equal(a.src, "/play/1");
  assert.equal(a.loop, false);
  assert.deepEqual(a.plays, [SILENCE, "/play/1"]);
  assert.equal(s.warm, false);
  // Resolved once: the next start of it goes straight to the stream.
  const b = new FakeAudio();
  assert.equal(await s.start(b, { resolve: "/resolve/1", src: "/play/1", autoplay: true }), true);
  assert.deepEqual(b.plays, ["/play/1"]);
});

test("a failed resolve still tries the stream (the server falls back)", async () => {
  const { s, calls } = setup();
  const a = new FakeAudio();
  const done = s.start(a, { resolve: "/resolve/2", src: "/play/2", autoplay: true });
  calls.get("/resolve/2")!.reject(new Error("502"));
  assert.equal(await done, true);
  assert.equal(a.src, "/play/2");
  assert.equal(s.isReady("/resolve/2"), false);
});

test("a later start supersedes a pending one", async () => {
  const { s, calls } = setup();
  const a = new FakeAudio();
  const first = s.start(a, { resolve: "/resolve/3", src: "/play/3", autoplay: true });
  const second = s.start(a, { resolve: null, src: "/stream/x", autoplay: true });
  assert.equal(await second, true);
  calls.get("/resolve/3")!.resolve();
  assert.equal(await first, false);
  assert.equal(a.src, "/stream/x");
});

test("cancel (pause while resolving) never starts the track", async () => {
  const { s, calls } = setup();
  const a = new FakeAudio();
  const p = s.start(a, { resolve: "/resolve/4", src: "/play/4", autoplay: true });
  s.cancel();
  assert.equal(s.warm, false);
  calls.get("/resolve/4")!.resolve();
  assert.equal(await p, false);
  assert.equal(a.src, SILENCE);
});

test("no autoplay: src is set, nothing plays, no silence", async () => {
  const { s } = setup();
  const a = new FakeAudio();
  assert.equal(await s.start(a, { resolve: "/resolve/5", src: "/play/5", autoplay: false }), true);
  assert.equal(a.src, "/play/5");
  assert.deepEqual(a.plays, []);
});

test("a hanging resolve gives up after the timeout", async () => {
  const s = new Starter({ silence: () => SILENCE, fetchResolve: () => new Promise(() => undefined), timeoutMs: 20 });
  const a = new FakeAudio();
  assert.equal(await s.start(a, { resolve: "/resolve/6", src: "/play/6", autoplay: true }), true);
  assert.equal(a.src, "/play/6");
});

test("prefetch shares one request and marks the track ready", async () => {
  const { s, calls } = setup();
  const p1 = s.prefetch("/resolve/7");
  const p2 = s.prefetch("/resolve/7");
  assert.equal(calls.size, 1);
  calls.get("/resolve/7")!.resolve();
  await Promise.all([p1, p2]);
  assert.equal(s.isReady("/resolve/7"), true);
  const a = new FakeAudio();
  await s.start(a, { resolve: "/resolve/7", src: "/play/7", autoplay: true });
  assert.deepEqual(a.plays, ["/play/7"]);
});

test("silenceWav is a valid, near-silent PCM WAV", () => {
  const w = silenceWav(1, 8000);
  const v = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...w.slice(8, 12)), "WAVE");
  assert.equal(v.getUint32(24, true), 8000);
  assert.equal(v.getUint32(40, true), 16000);
  assert.equal(w.length, 44 + 16000);
  for (let i = 44; i < w.length; i += 2) assert.ok(Math.abs(v.getInt16(i, true)) <= 1);
});
