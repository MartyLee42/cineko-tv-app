import assert from "node:assert/strict";
import { test } from "node:test";
import { averageRow, windowRange } from "../src/virtual.ts";

test("windowRange: top of a long list", () => {
  const r = windowRange(1000, 50, 0, 800);
  assert.equal(r.start, 0);
  assert.ok(r.end >= 16 + 12 && r.end <= 40, `end ${r.end}`);
});

test("windowRange: list lower on screen renders its first rows", () => {
  const r = windowRange(1000, 50, -300, 800);
  assert.equal(r.start, 0);
  assert.ok(r.end >= 10);
});

test("windowRange: middle, with overscan, snapped to chunks", () => {
  const r = windowRange(1000, 50, 25_005, 800, 12, 8);
  // rows 500..517 visible
  assert.ok(r.start <= 488 && r.start % 8 === 0, `start ${r.start}`);
  assert.ok(r.end >= 528 && r.end % 8 === 0, `end ${r.end}`);
  // A small scroll keeps the same range (no re-render).
  assert.deepEqual(windowRange(1000, 50, 25_030, 800, 12, 8), r);
});

test("windowRange: end of the list and past it", () => {
  assert.equal(windowRange(100, 50, 4_800, 800).end, 100);
  const past = windowRange(100, 50, 100_000, 800);
  assert.equal(past.end, 100);
  assert.ok(past.start < past.end);
});

test("windowRange: empty and unknown row height", () => {
  assert.deepEqual(windowRange(0, 50, 0, 800), { start: 0, end: 0 });
  assert.ok(windowRange(500, 0, 0, 800).end > 0);
});

test("averageRow", () => {
  assert.equal(averageRow(560, 10), 56);
  assert.equal(averageRow(0, 0), 0);
});
