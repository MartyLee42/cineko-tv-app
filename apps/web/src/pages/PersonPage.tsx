import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { formatDate, imageUrl, placeholderColor } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import { CatalogError, CatalogPage, Img, PosterCard, Tabs } from "../catalog/components";
import { isNotFound, useCatalogConfig, usePerson } from "../catalog/queries";
import { ageOf, initials, pickCredits, type CreditKind, type CreditSort } from "../catalog/person";
import { ChevronLeft } from "../icons";

/** /person/:tmdbId — an actor's (or director's) bio and everything they were in. */
export function PersonPage() {
  const { tmdbId = "" } = useParams();
  const id = Number(tmdbId);
  return (
    <CatalogPage>
      <Person key={id} id={Number.isInteger(id) ? id : 0} />
    </CatalogPage>
  );
}

function Person({ id }: { id: number }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: cfg } = useCatalogConfig();
  const q = usePerson(id);
  const [kind, setKind] = useState<CreditKind>("all");
  const [sort, setSort] = useState<CreditSort>("popular");
  const [bioOpen, setBioOpen] = useState(false);

  const back = (
    <button
      type="button"
      onClick={() => (location.key !== "default" ? navigate(-1) : navigate("/"))}
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"
    >
      <ChevronLeft /> {t("common.back")}
    </button>
  );

  if (q.isPending && id > 0)
    return (
      <div className="space-y-6">
        {back}
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </div>
    );
  if (!q.data || q.error)
    return (
      <div className="space-y-6">
        {back}
        {id <= 0 || isNotFound(q.error) ? (
          <p className="py-16 text-center text-muted" data-testid="person-missing">
            {t("catalog.person.not_found")}
          </p>
        ) : (
          <CatalogError error={q.error} onRetry={() => q.refetch()} />
        )}
      </div>
    );

  const p = q.data;
  const age = ageOf(p.birthday, p.deathday);
  const facts = [
    p.birthday && t("catalog.person.born", { date: formatDate(p.birthday, locale) ?? p.birthday }) + (age != null && !p.deathday ? ` (${t("catalog.person.age", { n: age })})` : ""),
    p.deathday && t("catalog.person.died", { date: formatDate(p.deathday, locale) ?? p.deathday }) + (age != null ? ` (${t("catalog.person.age", { n: age })})` : ""),
    p.place_of_birth,
  ].filter(Boolean) as string[];
  const hasMovies = p.credits.some((c) => c.media.kind === "movie");
  const hasSeries = p.credits.some((c) => c.media.kind === "series");
  const shown = pickCredits(p.credits, kind, sort);
  const longBio = p.biography.length > 420;

  return (
    <div className="space-y-8" data-testid="person" data-person-id={p.tmdb_id}>
      {back}
      <section className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
        <div
          className="relative aspect-[2/3] w-36 shrink-0 overflow-hidden rounded-2xl shadow-lg shadow-black/30 sm:w-48"
          style={{ background: placeholderColor(p.name) }}
        >
          <Img
            src={imageUrl(cfg, p.profile_path, "h632")}
            alt={p.name}
            eager
            className="absolute inset-0 h-full w-full object-cover"
            fallback={<span className="absolute inset-0 flex items-center justify-center text-4xl font-bold text-white/80">{initials(p.name)}</span>}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <h1 className="text-3xl font-extrabold leading-tight sm:text-4xl" data-testid="person-name">
            {p.name}
          </h1>
          {facts.length > 0 && (
            <ul className="space-y-0.5 text-sm text-muted">
              {facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {p.biography && (
            <div className="max-w-3xl">
              <p className={`whitespace-pre-line text-sm leading-relaxed text-text/90 sm:text-base ${longBio && !bioOpen ? "line-clamp-5" : ""}`}>{p.biography}</p>
              {longBio && (
                <button type="button" onClick={() => setBioOpen((o) => !o)} className="mt-1 text-sm font-semibold text-accent hover:text-accent-strong">
                  {bioOpen ? t("catalog.person.less") : t("catalog.person.more")}
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-bold">
          {t("catalog.person.filmography")} <span className="text-base font-normal text-muted">{p.credits.length}</span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {hasMovies && hasSeries && (
            <Tabs
              label={t("catalog.person.filmography")}
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: t("catalog.person.all") },
                { value: "movie", label: t("catalog.person.movies") },
                { value: "series", label: t("catalog.person.series") },
              ]}
            />
          )}
          <Tabs
            label={t("catalog.person.popular")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "popular", label: t("catalog.person.popular") },
              { value: "newest", label: t("catalog.person.newest") },
            ]}
          />
        </div>
        {shown.length ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 sm:gap-x-4 md:grid-cols-5 lg:grid-cols-6" data-testid="person-credits">
            {shown.map((c) => (
              <div key={c.media.id} data-testid="person-credit">
                <PosterCard item={c.media} sizes="(min-width: 1024px) 160px, (min-width: 640px) 25vw, 33vw" />
                {c.role && <p className="mt-0.5 line-clamp-2 text-xs italic leading-tight text-muted">{c.role}</p>}
              </div>
            ))}
          </div>
        ) : (
          <p className="py-10 text-center text-muted">{t("catalog.person.empty")}</p>
        )}
      </section>
    </div>
  );
}
