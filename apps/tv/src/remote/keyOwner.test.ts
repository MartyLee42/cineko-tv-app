import { describe, expect, it } from "vitest";
import { claimKeys, keysClaimed } from "./keyOwner";

describe("claimKeys", () => {
  it("the newest claim acts; releasing hands the keys back", () => {
    const a = claimKeys();
    const b = claimKeys();
    expect([a.top, b.top]).toEqual([false, true]);
    b.release();
    expect(a.top).toBe(true);
    a.release();
    expect(keysClaimed()).toBe(false);
  });

  it("a modal claim keeps the keys over claims made after it", () => {
    const player = claimKeys();
    const message = claimKeys({ modal: true });
    const invite = claimKeys(); // the quiz invite appears under the message card
    expect([player.top, message.top, invite.top]).toEqual([false, true, false]);
    message.release();
    expect(invite.top).toBe(true);
    invite.release();
    expect(player.top).toBe(true);
    player.release();
  });
});
