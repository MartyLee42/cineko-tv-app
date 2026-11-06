import { describe, expect, it } from "vitest";
import { groupAsText, isNewGroup, sinceFor, type ErrorGroup, type ErrorSample } from "./errors";

const group: ErrorGroup = {
  id: "00000000-0000-0000-0000-000000000001",
  app: "tv",
  kind: "error",
  message: "TypeError: x is undefined",
  top_frame: "at foo (main.js)",
  component: "Details",
  count: 7,
  users_affected: 2,
  devices_affected: 1,
  first_seen: "2026-10-01T10:00:00Z",
  last_seen: "2026-10-02T10:00:00Z",
  last_release: "20261001-1200",
  last_url: "/tv/details",
  status: "unresolved",
  resolved_at: null,
  regressed: true,
};

const sample: ErrorSample = {
  id: 1,
  occurred_at: "2026-10-02T10:00:00Z",
  received_at: "2026-10-02T10:00:01Z",
  count: 1,
  user: { id: "u", username: "alice", display_name: "Alice" },
  device: { id: "d", name: "Lounge TV" },
  profile_name: null,
  message: group.message,
  stack: "TypeError: x is undefined\n    at foo (main.js:1:2)",
  url: "/tv/details",
  component: "Details",
  release: "20261001-1200",
  user_agent: "Tizen",
  device_model: "Samsung",
  extra: { a: 1 },
  request_id: "",
};

describe("sinceFor", () => {
  it("returns undefined for all", () => expect(sinceFor("all")).toBeUndefined());
  it("subtracts the range, rounded to the minute", () => {
    const now = Date.parse("2026-10-29T12:00:30Z");
    expect(sinceFor("24h", now)).toBe("2026-10-28T12:00:00.000Z");
    expect(sinceFor("7d", now)).toBe("2026-10-22T12:00:00.000Z");
  });
});

describe("isNewGroup", () => {
  it("is new only after the last view", () => {
    expect(isNewGroup(group, null)).toBe(false);
    expect(isNewGroup(group, "2026-09-30T00:00:00Z")).toBe(true);
    expect(isNewGroup(group, "2026-10-01T10:00:00Z")).toBe(false);
  });
});

describe("groupAsText", () => {
  it("includes the essentials and the latest sample", () => {
    const txt = groupAsText(group, [sample]);
    expect(txt).toContain("[tv/error] TypeError: x is undefined");
    expect(txt).toContain("(regressed)");
    expect(txt).toContain("Count: 7 · users: 2 · devices: 1");
    expect(txt).toContain("Device: Lounge TV");
    expect(txt).toContain("User: Alice");
    expect(txt).toContain("at foo (main.js:1:2)");
    expect(txt).toContain('Extra: {"a":1}');
  });
  it("works without samples", () => {
    expect(groupAsText(group, [])).not.toContain("Latest sample");
  });
});
