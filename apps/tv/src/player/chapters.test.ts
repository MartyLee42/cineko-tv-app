import { describe, expect, it } from "vitest";
import { chapterIndexAt, chapterTicks, fileChapters, nextChapterStart, prevChapterStart, snapToChapter } from "@martytv/media-types";
import { accumulateSeek, chapterSeek } from "./keys";

const RAW = [
  { start_seconds: 600, end_seconds: 1200, title: "Chapter 02" },
  { start_seconds: 0, end_seconds: 600, title: "Opening" },
  { start_seconds: 1200, end_seconds: 3000, title: "Погоня" },
  { start_seconds: 3000, end_seconds: 3700, title: "00:50:00.000" },
];
const DUR = 3600;

describe("file chapters", () => {
  it("sorts, drops generic titles, cuts past the end; one chapter is no chapters", () => {
    const cs = fileChapters(RAW, DUR)!;
    expect(cs.map((c) => [c.start, c.title])).toEqual([
      [0, "Opening"],
      [600, null],
      [1200, "Погоня"],
      [3000, null],
    ]);
    expect(cs[3]!.end).toBe(DUR);
    expect(fileChapters([RAW[0]!], DUR)).toBeNull();
    expect(fileChapters(null, DUR)).toBeNull();
    // A chapter starting at the very end is dropped.
    expect(fileChapters([...RAW, { start_seconds: 3599.5, end_seconds: 3600, title: "End" }], DUR)!.length).toBe(4);
  });

  it("ticks skip the start of the film", () => {
    expect(chapterTicks(fileChapters(RAW, DUR), DUR)).toEqual([(600 / 3600) * 100, (1200 / 3600) * 100, (3000 / 3600) * 100]);
    expect(chapterTicks(null, DUR)).toEqual([]);
  });

  it("finds the current, next and previous chapter (CD-player style)", () => {
    const cs = fileChapters(RAW, DUR);
    expect(chapterIndexAt(cs, 0)).toBe(0);
    expect(chapterIndexAt(cs, 599)).toBe(0);
    expect(chapterIndexAt(cs, 600)).toBe(1);
    expect(chapterIndexAt(cs, 3500)).toBe(3);
    expect(nextChapterStart(cs, 10)).toBe(600);
    expect(nextChapterStart(cs, 599.5)).toBe(1200); // already at 600 (within 1.5 s)
    expect(nextChapterStart(cs, 3100)).toBeNull();
    expect(prevChapterStart(cs, 700)).toBe(600); // back to this chapter's start
    expect(prevChapterStart(cs, 602)).toBe(0); // just started: the previous one
    expect(prevChapterStart(cs, 2)).toBe(0);
    expect(prevChapterStart(cs, 0.3)).toBeNull();
  });

  it("a seek step stops at a chapter start it passes, never further than the step", () => {
    const cs = fileChapters(RAW, DUR);
    expect(snapToChapter(cs, 580, 610)).toBe(600);
    expect(snapToChapter(cs, 608, 598)).toBe(600);
    expect(snapToChapter(cs, 610, 640)).toBeNull();
    // Just landed on it / a couple of seconds away: the press goes on.
    expect(snapToChapter(cs, 600, 630)).toBeNull();
    expect(snapToChapter(cs, 598, 628)).toBeNull();
    expect(snapToChapter(cs, 600, 590)).toBeNull();
    // Backwards across two starts: the nearer one.
    expect(snapToChapter(cs, 1300, 500)).toBe(1200);
    expect(snapToChapter(null, 0, 30)).toBeNull();
  });
});

describe("◀▶ with chapters", () => {
  const cs = fileChapters(RAW, DUR);

  it("without chapters it is the plain accelerated seek", () => {
    expect(chapterSeek(null, 100, 1, DUR, null)).toEqual(accumulateSeek(null, 100, 1, DUR));
  });

  it("taps walk to the chapter start, then on as usual", () => {
    const a = chapterSeek(null, 580, 1, DUR, cs);
    expect(a).toMatchObject({ target: 600, snapped: true });
    const b = chapterSeek(a, 580, 1, DUR, cs);
    expect(b.target).toBe(630);
    expect(b.snapped).toBeUndefined();
    // Back across a start lands on it.
    expect(chapterSeek(null, 605 + 3, -1, DUR, cs).target).toBe(600);
  });

  it("holding (accelerated steps) stops at each chapter on the way", () => {
    let s = null as ReturnType<typeof chapterSeek> | null;
    const stops: number[] = [];
    for (let i = 0; i < 40 && (!s || s.target < 3000); i++) {
      s = chapterSeek(s, 0, 1, DUR, cs);
      if (s.snapped) stops.push(s.target);
    }
    expect(stops).toEqual([600, 1200, 3000]);
  });
});
