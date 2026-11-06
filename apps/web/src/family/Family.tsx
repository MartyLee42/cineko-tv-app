// «Семья советует» on the web: the family row decorations on Home (member
// match chips in the header, avatars + the "why" on cards) and «Оценки
// семьи» on the title page. Data: the family row comes with GET
// /foryou/rows (kind family); the title line from
// GET /profiles/{id}/family/media/{mediaId}.
import { useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { endorsementText, familyWhyText, likedByText, matchText, membersWithMatch, ProfileAvatar, useI18n } from "@martytv/ui";
import { api } from "../api";
import { useActiveProfile } from "../watch/ActiveProfile";

type ForYouRow = Schemas["ForYouRow"];
type ForYouItem = Schemas["ForYouItem"];
type Person = Schemas["FamilyEndorsement"];

/** Row header extra: «совпадение вкусов» per member (best first). */
export function FamilyRowHeader({ row }: { row: ForYouRow }) {
  const { t } = useI18n();
  const members = membersWithMatch(row.family?.members ?? [], 4);
  if (members.length === 0) return <p className="mt-0.5 text-xs text-muted">{t("family.row_hint")}</p>;
  return (
    <ul className="mt-1 flex flex-wrap gap-1.5" data-testid="family-members">
      {members.map((m) => (
        <li
          key={m.profile_id}
          title={matchText(m, t) ?? m.name}
          className="flex items-center gap-1.5 rounded-full border border-border bg-surface py-0.5 pl-0.5 pr-2.5 text-xs text-muted"
        >
          <ProfileAvatar name={m.name} color={m.color} avatar={m.avatar} size={20} className="!rounded-full" />
          <span className="font-semibold text-text">{m.name}</span>
          {t("family.match_short", { n: m.match ?? 0 })}
        </li>
      ))}
    </ul>
  );
}

function Avatars({ people, size }: { people: Person[]; size: number }) {
  return (
    <span className="flex -space-x-1.5">
      {people.slice(0, 3).map((p) => (
        <ProfileAvatar key={p.profile_id} name={p.name} color={p.color} avatar={p.avatar} size={size} className="!rounded-full ring-2 ring-black/60" />
      ))}
    </span>
  );
}

/** Card extra: who liked it (avatars on the poster) and the "why" line under the title. */
export function FamilyCardExtra({ item }: { item: ForYouItem }) {
  const { t } = useI18n();
  const why = item.reason.family;
  if (!why) return null;
  const liked = likedByText(why.liked_by, t);
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex aspect-[2/3] items-end p-1.5" aria-hidden>
        <Avatars people={why.people} size={24} />
      </div>
      <p data-testid="family-why" className="mt-1 line-clamp-2 text-xs font-medium leading-snug text-accent-strong">
        {liked ? `${liked} · ` : ""}
        {familyWhyText(why, t)}
      </p>
    </>
  );
}

const missing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405);

export function useMediaFamily(mediaId: string) {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["family", "media", profileId, mediaId],
    enabled: !!profileId,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      unwrap(api.GET("/profiles/{id}/family/media/{mediaId}", { params: { path: { id: profileId!, mediaId } } })).catch((e) => {
        if (missing(e)) return { enabled: false, people: [] };
        throw e;
      }),
  });
}

/** Title page: «Оценки семьи: Анна ★9 · Олег: посмотрено вчера». Hidden when empty. */
export function FamilyRatings({ mediaId }: { mediaId: string }) {
  const { t } = useI18n();
  const q = useMediaFamily(mediaId);
  const people = q.data?.people ?? [];
  if (people.length === 0) return null;
  return (
    <div data-testid="title-family" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted">{t("family.ratings_title")}</span>
      {people.map((p) => (
        <span key={p.profile_id} className="flex items-center gap-1.5" title={p.user_name && p.user_name !== p.name ? `${p.name} (${p.user_name})` : p.name}>
          <ProfileAvatar name={p.name} color={p.color} avatar={p.avatar} size={22} className="!rounded-full" />
          <span className={p.liked ? "font-semibold text-text" : "text-text/80"}>{endorsementText(p, t)}</span>
        </span>
      ))}
    </div>
  );
}
