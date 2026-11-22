// Who handles remote keys right now. Full-screen layers that listen on
// window themselves (player, settings, message/rating overlays) claim the
// keys while shown; only the most recent claim acts, so an overlay over the
// player gets OK/Back instead of the player.
//
// A modal claim (an admin message card, drawn over everything on Home) stays
// on top of claims made after it: a layer that appears later underneath it —
// the taste-quiz invite 2.5 s after Home, a player whose effect re-claims —
// must not take OK/Back from the card the viewer is looking at.
const stack: { modal: boolean }[] = [];

export interface KeyClaim {
  /** True while this claim is the one that acts. */
  readonly top: boolean;
  release(): void;
}

function owner(): object | undefined {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.modal) return stack[i];
  return stack[stack.length - 1];
}

export function claimKeys(opts: { modal?: boolean } = {}): KeyClaim {
  const token = { modal: !!opts.modal };
  stack.push(token);
  return {
    get top() {
      return owner() === token;
    },
    release() {
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    },
  };
}

/** Whether any layer claimed the keys (the catalog's own handlers stand back). */
export function keysClaimed(): boolean {
  return stack.length > 0;
}
