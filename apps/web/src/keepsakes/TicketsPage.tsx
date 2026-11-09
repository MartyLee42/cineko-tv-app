import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import type { AchievementList } from "@martytv/contracts";
import { imageUrl } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import { countKey, knownStickers, secretKey, StickerCard, TicketCard } from "@martytv/ui/keepsakes";
import { Button } from "../components";
import { CatalogError } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { useActiveProfile } from "../watch/ActiveProfile";
import { NoProfile } from "../pages/HistoryPage";
import { useAchievements, useTickets } from "./queries";

/**
 * «Билеты»: the active profile's ticket wall (a stub per finished film,
 * newest first) and, above it, the stickers it has earned. Silent: nothing
 * here ever notifies; locked stickers are only counted.
 */
export function TicketsPage() {
  const { t, locale } = useI18n();
  const { profile } = useActiveProfile();
  const { data: cfg } = useCatalogConfig();
  const tq = useTickets();
  const aq = useAchievements();
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = tq;
  const tickets = useMemo(() => tq.data?.pages.flatMap((p) => p.items) ?? [], [tq.data]);
  const first = tq.data?.pages[0];

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchingNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void fetchNextPage(), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, tickets.length]);

  if (!profile) return <NoProfile />;
  return (
    <div data-testid="tickets-page">
      <div className="mb-5">
        <h1 className="text-2xl font-bold sm:text-3xl">{t("keepsakes.tickets")}</h1>
        <p className="mt-0.5 text-sm text-muted">
          {[profile.name, first ? t(countKey(locale, first.total), { n: first.total }) : null].filter(Boolean).join(" · ")}
        </p>
      </div>
      {aq.data && <StickerSheet list={aq.data} />}
      {tq.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : tq.error && !tq.data ? (
        <CatalogError error={tq.error} onRetry={() => tq.refetch()} />
      ) : !tickets.length ? (
        <p className="mx-auto max-w-md py-16 text-center text-muted" data-testid="tickets-empty">
          {t("keepsakes.empty")}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">{t("keepsakes.hint")}</p>
          <ol className="grid grid-cols-1 gap-x-6 gap-y-5 text-[14px] sm:grid-cols-2 sm:text-[15px] xl:grid-cols-3" data-testid="ticket-wall">
            {tickets.map((s) => (
              <li key={s.number}>
                <Link to={`/title/${s.media.id}`} className="block rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent" aria-label={s.media.title}>
                  <TicketCard ticket={s} poster={imageUrl(cfg, s.media.poster_path, "w185")} cinema={first?.cinema} className="ks-hover" />
                </Link>
              </li>
            ))}
          </ol>
          <div ref={sentinel} className="flex min-h-[64px] items-center justify-center pt-4">
            {isFetchingNextPage ? (
              <Spinner />
            ) : hasNextPage ? (
              <Button variant="secondary" onClick={() => fetchNextPage()}>
                {t("catalog.load_more")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** The earned stickers on a sheet, then the counter stickers on their way; nothing at all until there is one. */
function StickerSheet({ list }: { list: AchievementList }) {
  const { t, locale } = useI18n();
  const items = knownStickers(list.items);
  const next = knownStickers(list.progress ?? []);
  if (!items.length && !next.length) return null;
  const secret = secretKey(locale, list.secret);
  return (
    <section className="ks-sheet mb-7 rounded-2xl border border-border bg-surface px-3 pb-4 pt-3 sm:px-5" data-testid="sticker-sheet">
      {items.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted">{t("keepsakes.stickers")}</h2>
          <div className="-mx-1 flex flex-wrap text-[12px] sm:text-[15px]">
            {items.map((a) => (
              <div key={a.id} className="px-1 py-1">
                <StickerCard id={a.id} date={a.date} title={a.media_title} />
              </div>
            ))}
          </div>
        </>
      )}
      {next.length > 0 && (
        <>
          <h2 className={`mb-2 text-sm font-semibold uppercase tracking-wider text-muted ${items.length ? "mt-4" : ""}`}>{t("keepsakes.next")}</h2>
          <div className="-mx-1 flex flex-wrap text-[12px] sm:text-[15px]" data-testid="sticker-next">
            {next.map((p) => (
              <div key={p.id} className="px-1 py-1">
                <StickerCard id={p.id} progress={p} />
              </div>
            ))}
          </div>
        </>
      )}
      {(secret || !next.length) && (
        <p className="mt-2 text-xs text-muted" data-testid="sticker-secret">
          {secret ? t(secret, { n: list.secret }) : t("keepsakes.all_found")}
        </p>
      )}
    </section>
  );
}
