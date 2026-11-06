// Cineko reacts to a title's genre on its details page: hides from horror
// (only peeking out), laughs at comedy, gets misty at drama. Small and
// quiet; nothing in «Конструктивизм» (no mascot there). Transform/opacity
// animations only (cheap on TV engines).
import { Mascot } from "./components";
import { useAppliedDesign } from "./designs";
import { genreReaction } from "./genreReaction";
import { useI18n } from "./i18n";

const CSS = `
@keyframes mtgPeek{0%,100%{transform:translateY(58%)}40%,70%{transform:translateY(22%)}}
@keyframes mtgBounce{0%,100%{transform:translateY(0) rotate(0)}30%{transform:translateY(-12%) rotate(-4deg)}60%{transform:translateY(0) rotate(3deg)}}
@keyframes mtgDrop{0%{transform:translateY(0);opacity:0}15%{opacity:1}100%{transform:translateY(240%);opacity:0}}
@media (prefers-reduced-motion: reduce){.mtg-anim{animation:none!important}}
`;

export function GenreReaction({ genres, size = 80, className = "" }: { genres: readonly { id: number }[] | null | undefined; size?: number; className?: string }) {
  const { t } = useI18n();
  const design = useAppliedDesign();
  const plan = genreReaction(genres);
  if (!plan || design === "constructivism") return null;
  const line = t(plan.line);
  return (
    <span
      data-testid="genre-reaction"
      data-reaction={plan.kind}
      role="img"
      aria-label={line}
      title={line}
      className={`relative inline-block shrink-0 align-middle ${className}`}
      // Horror: he hides below an edge (the box clips him), peeking up now and then.
      style={{ width: size, height: size, overflow: plan.kind === "horror" ? "hidden" : "visible" }}
    >
      <style>{CSS}</style>
      <span
        className="mtg-anim absolute left-0 top-0 block h-full w-full"
        style={
          plan.kind === "horror"
            ? { animation: "mtgPeek 4.5s ease-in-out infinite", transform: "translateY(58%)" }
            : plan.kind === "comedy"
              ? { animation: "mtgBounce 1.1s ease-in-out infinite", transformOrigin: "50% 100%" }
              : undefined
        }
      >
        <Mascot mood={plan.mood} size={size} animated={false} />
      </span>
      {plan.kind === "drama" && (
        <span
          className="mtg-anim absolute block rounded-full"
          // A drop running down his cheek (under the right eye of the rain sticker).
          style={{ left: "70%", top: "70%", width: size * 0.06, height: size * 0.09, background: "#7cc8ff", boxShadow: "0 0 6px #7cc8ff", animation: "mtgDrop 2.4s ease-in infinite" }}
        />
      )}
    </span>
  );
}
