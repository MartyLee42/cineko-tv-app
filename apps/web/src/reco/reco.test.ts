import { describe, expect, it } from "vitest";
import type { Recommendation } from "@martytv/contracts";
import { applyPatch, countUnseen, joinNames, nextReaction, personName, removeFromInbox, rowItems, toggleId } from "./logic";

const person = { user_id: "u", name: "Alice", color: "#123456", avatar: "" };
function reco(id: string, mediaId: string, created: string, seen: string | null = null): Recommendation {
  return {
    id,
    media: { id: mediaId, title: mediaId } as Recommendation["media"],
    from: person,
    to: person,
    note: "",
    created_at: created,
    seen_at: seen,
    reaction: null,
    reply: null,
  };
}

describe("reco logic", () => {
  it("joins names per locale", () => {
    expect(joinNames(["Bob"], "en")).toBe("Bob");
    expect(joinNames(["Bob", "Carol", "Dave"], "en")).toBe("Bob, Carol, and Dave");
    expect(joinNames(["Боб", "Кэрол"], "ru")).toBe("Боб и Кэрол");
  });

  it("applies seen and reactions optimistically", () => {
    const inbox = { items: [reco("a", "m1", "2026-01-01T00:00:00Z"), reco("b", "m2", "2026-01-02T00:00:00Z")], unseen: 2 };
    const seen = applyPatch(inbox, "a", { seen: true }, "NOW");
    expect(seen.items[0]!.seen_at).toBe("NOW");
    expect(seen.unseen).toBe(1);
    const liked = applyPatch(seen, "b", { reaction: "like" }, "LATER");
    expect(liked.items[1]).toMatchObject({ reaction: "like", seen_at: "LATER" });
    expect(liked.unseen).toBe(0);
    // Already seen keeps its time; clearing a reaction keeps it seen.
    const cleared = applyPatch(liked, "b", { reaction: null }, "X");
    expect(cleared.items[1]).toMatchObject({ reaction: null, seen_at: "LATER" });
    expect(applyPatch(cleared, "a", { seen: false }).unseen).toBe(1);
    expect(countUnseen(inbox.items)).toBe(2);
  });

  it("removes from the inbox and recounts", () => {
    const inbox = { items: [reco("a", "m1", "2026-01-01T00:00:00Z"), reco("b", "m2", "2026-01-02T00:00:00Z", "S")], unseen: 1 };
    expect(removeFromInbox(inbox, "a")).toEqual({ items: [inbox.items[1]], unseen: 0 });
  });

  it("toggles reactions and selection", () => {
    expect(nextReaction(null, "like")).toBe("like");
    expect(nextReaction("like", "like")).toBeNull();
    expect(nextReaction("like", "watched")).toBe("watched");
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });

  it("orders the Home row: unseen first, newest first, one card per title", () => {
    const items = [
      reco("old-seen", "m1", "2026-01-01T00:00:00Z", "S"),
      reco("new-seen", "m2", "2026-01-05T00:00:00Z", "S"),
      reco("old-unseen", "m3", "2026-01-02T00:00:00Z"),
      reco("new-unseen", "m4", "2026-01-04T00:00:00Z"),
      reco("dup", "m4", "2026-01-03T00:00:00Z"),
    ];
    expect(rowItems(items).map((r) => r.id)).toEqual(["new-unseen", "old-unseen", "new-seen", "old-seen"]);
    expect(rowItems(items, 2)).toHaveLength(2);
  });

  it("names people", () => {
    expect(personName({ username: "bob", display_name: "" })).toBe("bob");
    expect(personName({ username: "bob", display_name: " Bob M " })).toBe("Bob M");
  });
});
