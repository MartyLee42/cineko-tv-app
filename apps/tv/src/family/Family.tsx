// «Семья советует» on the TV: the avatar chip on family-row cards, the hero
// "why" line (who liked it, «Понравилось двоим», taste match), and
// «Оценки семьи» in Details. The row itself comes with GET /foryou/rows
// (kind family), so Home renders it like any «Для вас» row.
import { useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { endorsementText, familyWhyText, likedByText, matchText, reasonText, useI18n, type MessageKey } from "@martytv/ui";
import { api } from "../api";
import { legacyColor } from "../components/Img";
import { initial } from "../design/format";
import type { Design } from "../design/context";
import { useActiveProfileId } from "../profile/active";

type ForYouRow = Schemas["ForYouRow"];
type ForYouItem = Schemas["ForYouItem"];
type Person = Schemas["FamilyEndorsement"];
type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

function Avatar({ p, size }: { p: Pick<Person, "name" | "avatar" | "color">; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-2 ring-black/60"
      style={{ width: size, height: size, fontSize: size * 0.5, background: legacyColor(p.color || "#64748b") }}
    >
      {p.avatar || initial(p.name)}
    </span>
  );
}

/** Card chip (top-left): the members' avatars and the first one's rating. */
export function FamilyChip({ item, design }: { item: ForYouItem; design: Design }) {
  const why = item.reason.family;
  const first = why?.people[0];
  if (!why || !first) return null;
  const mark = first.rating != null ? `★${first.rating}` : first.favorite && !first.completed ? "♥" : "✓";
  if (design === "terminal") {
    return (
      <span data-family-from={first.name} className="t-tag t-label absolute left-0 top-0 max-w-full truncate px-2 py-0.5 font-mono text-[16px] text-accent">
        {first.name} · {mark}
        {why.people.length > 1 ? ` +${why.people.length - 1}` : ""}
      </span>
    );
  }
  return (
    <span data-family-from={first.name} className="absolute left-2 top-2 flex max-w-[85%] items-center rounded-full bg-black/70 py-[3px] pl-[3px] pr-3 text-[18px] text-white">
      <span className="flex -space-x-2">
        {why.people.slice(0, 3).map((p) => (
          <Avatar key={p.profile_id} p={p} size={26} />
        ))}
      </span>
      <span className="ml-2 truncate">{mark}</span>
    </span>
  );
}

/** The hero/focus "why" for a «Для вас» item; family items get who + «Понравилось двоим» + match. */
export function fyReason(row: ForYouRow, it: ForYouItem, t: T): string {
  const why = it.reason.family;
  if (row.kind !== "family" || !why) return reasonText(it.reason, t);
  const parts = [likedByText(why.liked_by, t), familyWhyText(why, t, new Date(), 3)];
  const first = why.people[0];
  const member = first && row.family?.members.find((m) => m.profile_id === first.profile_id);
  if (member) parts.push(matchText(member, t));
  return parts.filter(Boolean).join(" · ");
}

const missing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405);

export function useMediaFamily(mediaId: string | undefined) {
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: ["family", "media", profile, mediaId],
    enabled: !!profile && !!mediaId,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      unwrap(api.GET("/profiles/{id}/family/media/{mediaId}", { params: { path: { id: profile!, mediaId: mediaId! } } })).catch((e) => {
        if (missing(e)) return { enabled: false, people: [] };
        throw e;
      }),
  });
}

/** Details: «Оценки семьи» card (hidden when nobody in the family shares this title). */
export function FamilyNote({ mediaId, design, spaced }: { mediaId: string | undefined; design: Design; spaced?: boolean }) {
  const { t } = useI18n();
  const q = useMediaFamily(mediaId);
  const people = (q.data?.people ?? []).slice(0, 4);
  if (people.length === 0) return null;
  const box = design === "terminal" ? "border-l-4 border-accent bg-surface/90" : design === "projector" ? "tv-panel rounded-[28px]" : "rounded-[22px] bg-surface/90";
  return (
    <div data-testid="family-note" className={`px-8 py-6 ${box} ${spaced ? "mt-5" : ""}`}>
      <p className={design === "terminal" ? "t-label text-[17px] text-accent" : "text-[20px] text-muted"}>{t("family.ratings_title")}</p>
      <ul className="mt-3 space-y-2">
        {people.map((p) => (
          <li key={p.profile_id} className="flex items-center gap-3 text-[24px] leading-snug text-text">
            <Avatar p={p} size={36} />
            <span className="truncate">{endorsementText(p, t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
