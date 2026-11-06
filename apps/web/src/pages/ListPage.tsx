import { Link, Navigate, useParams } from "react-router";
import { useI18n } from "@martytv/ui";
import { CatalogPage, InfinitePosterGrid } from "../catalog/components";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useProfileList, type ListName } from "../watch/queries";
import { NoProfile } from "./HistoryPage";

const LISTS: ListName[] = ["watchlist", "favorites"];

/** /lists/watchlist and /lists/favorites of the active profile. */
export function ListPage() {
  const { list = "" } = useParams();
  if (!LISTS.includes(list as ListName)) return <Navigate to="/lists/watchlist" replace />;
  return <ListView key={list} list={list as ListName} />;
}

function ListView({ list }: { list: ListName }) {
  const { t } = useI18n();
  const { profile } = useActiveProfile();
  const query = useProfileList(list);
  const other = list === "watchlist" ? "favorites" : "watchlist";
  return (
    <CatalogPage>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{t(`lists.${list}`)}</h1>
          {profile && <p className="mt-0.5 text-sm text-muted">{profile.name}</p>}
        </div>
        <div className="flex gap-2 text-sm font-semibold">
          <Link to={`/lists/${other}`} className="flex min-h-[40px] items-center rounded-xl bg-surface-2 px-3.5 hover:bg-border">
            {t(`lists.${other}`)}
          </Link>
          <Link to="/history" className="flex min-h-[40px] items-center rounded-xl bg-surface-2 px-3.5 hover:bg-border">
            {t("watch.history")}
          </Link>
        </div>
      </div>
      {profile ? (
        <div data-testid={`list-${list}`}>
          <InfinitePosterGrid query={query} empty={t("lists.empty")} />
        </div>
      ) : (
        <NoProfile />
      )}
    </CatalogPage>
  );
}
