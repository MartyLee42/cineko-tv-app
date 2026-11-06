import { Link } from "react-router";
import { imageUrl } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import { ErrorText, PageTitle, timeAgo } from "../components";
import { Img } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { NoProfile } from "../pages/HistoryPage";
import { useActiveProfile } from "../watch/ActiveProfile";
import { reasonKey } from "./notes";
import { useNotes } from "./queries";

/** «Мои заметки»: the active profile's private notes on titles, newest first. */
export function NotesPage() {
  const { t, locale } = useI18n();
  const { profile } = useActiveProfile();
  const cfg = useCatalogConfig();
  const q = useNotes();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="notes-page">
      <PageTitle>{t("taste.notes.title")}</PageTitle>
      <p className="-mt-2 text-sm text-muted">{t("taste.notes.subtitle")}</p>
      {!profile ? (
        <NoProfile />
      ) : q.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : !items.length ? (
        <p className="py-12 text-center text-muted" data-testid="notes-empty">
          {t("taste.notes.empty")}
        </p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((n) => (
            <li key={n.media.id} data-testid="note-item" data-media-id={n.media.id}>
              <Link to={`/title/${n.media.id}`} className="flex gap-3 rounded-2xl border border-border bg-surface p-2.5 hover:border-muted">
                <Img
                  src={imageUrl(cfg.data, n.media.poster_path, "w185")}
                  alt=""
                  className="h-24 w-16 shrink-0 rounded-lg object-cover"
                  fallback={<span className="h-24 w-16 shrink-0 rounded-lg bg-surface-2" />}
                />
                <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
                  <p className="truncate font-semibold">
                    {n.media.title}
                    {n.media.year && <span className="ml-1.5 font-normal text-muted">{n.media.year}</span>}
                    {n.media.me?.rating != null && <span className="ml-2 text-sm text-accent-strong">★ {n.media.me.rating}</span>}
                  </p>
                  {n.reasons.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {n.reasons.map((r) => (
                        <span key={r} className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold">
                          {t(reasonKey(r))}
                        </span>
                      ))}
                    </div>
                  )}
                  {n.text && <p className="line-clamp-3 text-sm">{n.text}</p>}
                  <p className="text-xs text-muted">{timeAgo(n.updated_at, locale)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="flex justify-center">
          <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} className="min-h-[44px] rounded-xl bg-surface-2 px-5 font-semibold hover:bg-border">
            {t("taste.notes.more")}
          </button>
        </div>
      )}
    </div>
  );
}
