// Cineko's reaction to a title's genre on its details page. Pure.
import type { MascotMood } from "./marty";

export type GenreReactionKind = "horror" | "comedy" | "drama";

/** TMDB genre ids (movies; TV shares comedy 35 and drama 18). */
const HORROR = 27;
const COMEDY = 35;
const DRAMA = 18;

export interface GenreReactionPlan {
  kind: GenreReactionKind;
  mood: MascotMood;
  /** Locale key of the little line he says (aria label / tooltip). */
  line: "mascot.genre.horror" | "mascot.genre.comedy" | "mascot.genre.drama";
}

const PLANS: Record<GenreReactionKind, GenreReactionPlan> = {
  // Hides, only peeking out.
  horror: { kind: "horror", mood: "surprised", line: "mascot.genre.horror" },
  // Laughs with a little bounce.
  comedy: { kind: "comedy", mood: "happy", line: "mascot.genre.comedy" },
  // Gets misty: under his umbrella, a drop runs down.
  drama: { kind: "drama", mood: "rain", line: "mascot.genre.drama" },
};

/** The reaction for a title's genres (horror > comedy > drama), or null. */
export function genreReaction(genres: readonly { id: number }[] | null | undefined): GenreReactionPlan | null {
  if (!genres?.length) return null;
  const ids = new Set(genres.map((g) => g.id));
  if (ids.has(HORROR)) return PLANS.horror;
  if (ids.has(COMEDY)) return PLANS.comedy;
  if (ids.has(DRAMA)) return PLANS.drama;
  return null;
}
