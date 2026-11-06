// Who handles remote keys right now. Full-screen layers that listen on
// window themselves (player, settings, message/rating overlays) claim the
// keys while shown; only the most recent claim acts, so an overlay over the
// player gets OK/Back instead of the player.
const stack: object[] = [];

export interface KeyClaim {
  /** True while this claim is the newest one. */
  readonly top: boolean;
  release(): void;
}

export function claimKeys(): KeyClaim {
  const token = {};
  stack.push(token);
  return {
    get top() {
      return stack[stack.length - 1] === token;
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
