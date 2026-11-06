import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { Spinner, useI18n } from "@martytv/ui";
import { timeAgo } from "../components";
import { Backdrop, CatalogError, CatalogPage, PosterGrid } from "../catalog/components";
import { isNotFound } from "../catalog/queries";
import { ChevronLeft } from "../icons";
import { NoProfile } from "../pages/HistoryPage";
import { useActiveProfile } from "../watch/ActiveProfile";
import { AiBadge } from "./ExplorePage";
import { useCollection, useFeedback } from "./queries";

/** An AI collection (подборка): title, description, «Подборка дня» badge and its titles. */
export function CollectionPage() {
  const { t, locale } = useI18n();
  const { id = "" } = useParams();
  const { profile } = useActiveProfile();
  const q = useCollection(id);
  const feedback = useFeedback();
  const c = q.data;
  const ids = c?.items.map((m) => m.id).join(",") ?? "";
  useEffect(() => {
    for (const m of ids.split(",")) if (m) feedback(m, "impression", `collection:${id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, id]);

  const hero = c?.items.find((m) => m.backdrop_path) ?? null;
  return (
    <CatalogPage>
      <div className="space-y-6">
        <Link to="/explore" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ChevronLeft /> {t("fy.explore.title")}
        </Link>
        {!profile ? (
          <NoProfile />
        ) : q.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : q.error ? (
          isNotFound(q.error) ? (
            <p className="py-16 text-center text-muted" data-testid="collection-missing">
              {t("fy.collection.not_found")}
            </p>
          ) : (
            <CatalogError error={q.error} onRetry={() => q.refetch()} />
          )
        ) : !c ? null : (
          <>
            <section className="relative -mx-4 overflow-hidden sm:mx-0 sm:rounded-3xl" data-testid="collection">
              {hero && <Backdrop path={hero.backdrop_path} title={hero.title} />}
              <div className={`relative flex flex-col gap-3 px-5 pb-6 sm:max-w-3xl sm:px-10 sm:pb-9 ${hero ? "min-h-[300px] justify-end pt-20 sm:min-h-[340px]" : "pt-6"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <AiBadge />
                  <span className="rounded-full bg-black/40 px-2.5 py-0.5 text-xs font-semibold text-white/90">
                    {c.scope === "profile" ? t("fy.collection.personal") : t("fy.collection.global")}
                  </span>
                </div>
                <h1 className="text-3xl font-extrabold leading-tight drop-shadow sm:text-4xl" data-testid="collection-title">
                  {c.title}
                </h1>
                {c.description && <p className="max-w-2xl text-sm leading-relaxed text-text/85 sm:text-base">{c.description}</p>}
                <p className="text-xs text-muted">
                  {[t("fy.collection.count", { n: c.items.length }), timeAgo(c.generated_at, locale), c.model && t("fy.collection.model", { model: c.model })]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </section>
            {c.items.length ? <PosterGrid items={c.items} /> : <p className="py-16 text-center text-muted">{t("fy.browse.empty")}</p>}
          </>
        )}
      </div>
    </CatalogPage>
  );
}
