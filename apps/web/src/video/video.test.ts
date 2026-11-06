import { describe, expect, it } from "vitest";
import { ApiError } from "@martytv/contracts";
import {
  appendUnique,
  channelNextPage,
  feedNextOffset,
  retryDelay,
  searchNextPage,
  compactCount,
  countForm,
  formatDuration,
  isVideoUnavailable,
  linkify,
  parseTab,
  progressPercent,
  relativeDate,
  resumePosition,
  shouldReport,
} from "./logic";

const NOW = Date.parse("2026-10-29T12:00:00Z");

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(187)).toBe("3:07");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(0)).toBe("0:00");
  });
  it("is empty for live / unknown", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });
});

describe("counts", () => {
  it("abbreviates large numbers", () => {
    expect(compactCount(999, "en")).toBe("999");
    expect(compactCount(12_345, "en")).toBe("12K");
    expect(compactCount(1_234_567, "en")).toBe("1.2M");
    expect(compactCount(1_234_567, "ru")).toMatch(/^1,2\s?млн$/);
  });
  it("picks the plural form", () => {
    expect(countForm(1, "ru")).toBe("one");
    expect(countForm(3, "ru")).toBe("few");
    expect(countForm(11, "ru")).toBe("many");
    expect(countForm(21, "ru")).toBe("one");
    expect(countForm(5000, "ru")).toBe("many");
    expect(countForm(1, "en")).toBe("one");
    expect(countForm(2, "en")).toBe("other");
    expect(countForm(5000, "en")).toBe("other");
  });
});

describe("relativeDate", () => {
  it("formats the largest unit", () => {
    expect(relativeDate("2026-10-26T12:00:00Z", NOW, "en")).toBe("3 days ago");
    expect(relativeDate("2026-10-29T09:00:00Z", NOW, "en")).toBe("3 hours ago");
    expect(relativeDate("2025-10-01T12:00:00Z", NOW, "en")).toBe("last year");
    expect(relativeDate("2026-10-26T12:00:00Z", NOW, "ru")).toBe("3 дня назад");
  });
  it("is empty without a date", () => {
    expect(relativeDate(null, NOW, "en")).toBe("");
    expect(relativeDate("nope", NOW, "en")).toBe("");
  });
});

describe("progress", () => {
  const p = (position_seconds: number, duration_seconds: number, finished = false) => ({ position_seconds, duration_seconds, finished, updated_at: "2026-10-29T00:00:00Z" });
  it("computes the bar", () => {
    expect(progressPercent(null)).toBe(0);
    expect(progressPercent(p(30, 120))).toBe(25);
    expect(progressPercent(p(30, 0), 60)).toBe(50);
    expect(progressPercent(p(10, 100, true))).toBe(100);
    expect(progressPercent(p(500, 100))).toBe(100);
  });
  it("resumes only from the middle", () => {
    expect(resumePosition(null, 600)).toBe(0);
    expect(resumePosition(3, 600)).toBe(0);
    expect(resumePosition(120, 600)).toBe(120);
    expect(resumePosition(590, 600)).toBe(0);
    expect(resumePosition(120, null)).toBe(120);
  });
  it("reports every 10 s or after a seek", () => {
    expect(shouldReport(null, 0.5)).toBe(false);
    expect(shouldReport(null, 3)).toBe(true);
    expect(shouldReport(3, 9)).toBe(false);
    expect(shouldReport(3, 13)).toBe(true);
    expect(shouldReport(300, 20)).toBe(true);
  });
});

describe("helpers", () => {
  it("detects the unavailable service", () => {
    expect(isVideoUnavailable(new ApiError(503, { error: { code: "video_unavailable", message: "down" } }))).toBe(true);
    expect(isVideoUnavailable(new ApiError(404, { error: { code: "not_found", message: "nope" } }))).toBe(false);
    expect(isVideoUnavailable(new Error("x"))).toBe(false);
  });
  it("appends without duplicates", () => {
    expect(appendUnique([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }, { id: "c" }]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  it("linkifies descriptions", () => {
    expect(linkify("Site: https://example.com/a?b=1. More (https://x.org)")).toEqual([
      { text: "Site: " },
      { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { text: ". More (" },
      { text: "https://x.org", href: "https://x.org" },
      { text: ")" },
    ]);
    expect(linkify("javascript:alert(1)")).toEqual([{ text: "javascript:alert(1)" }]);
  });
  it("parses the tab", () => {
    expect(parseTab("history")).toBe("history");
    expect(parseTab("bogus")).toBe("subscriptions");
    expect(parseTab(null)).toBe("subscriptions");
  });
});

describe("paging", () => {
  it("feed: next_offset until null", () => {
    expect(feedNextOffset({ next_offset: 50 })).toBe(50);
    expect(feedNextOffset({ next_offset: null })).toBeUndefined();
    expect(feedNextOffset({})).toBeUndefined();
    expect(feedNextOffset(undefined)).toBeUndefined();
  });
  it("search: next page while pages bring videos, up to the max", () => {
    expect(searchNextPage({ page: 1, videos: [1] }, 20)).toBe(2);
    expect(searchNextPage({ page: 3, videos: [] }, 20)).toBeUndefined();
    expect(searchNextPage({ page: 20, videos: [1] }, 20)).toBeUndefined();
  });
  it("channel: the continuation token", () => {
    expect(channelNextPage({ continuation: "abc" })).toBe("abc");
    expect(channelNextPage({ continuation: null })).toBeUndefined();
    expect(channelNextPage({ continuation: "" })).toBeUndefined();
  });
  it("retry backoff: 2 s doubling, capped at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map((a) => retryDelay(a))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(retryDelay(-1)).toBe(2000);
  });
});
