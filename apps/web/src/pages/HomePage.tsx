import { Link } from "react-router";
import type { MediaSummary } from "@martytv/contracts";
import { Mascot, martyMood, ProfileAvatar, StatusDot, useI18n, type MessageKey } from "@martytv/ui";
import { useEffect, useState } from "react";
import { useSession } from "../session";
import { useDevices, useProfiles } from "../queries";
import { Backdrop, CatalogError, CatalogPage, PosterRow, RatingBadge } from "../catalog/components";
import { useHomeRows } from "../catalog/queries";
import { browseToParams } from "../catalog/filters";
import { ContinueRow, RatePrompt } from "../watch/components";
import { useProfileList } from "../watch/queries";
import { RecoRow } from "../reco/RecoRow";
import { ForYouSection } from "../foryou/ForYouSection";
import { AskAiCard } from "../foryou/AskPage";
import { TvCard } from "../iptv/TvCard";
import { HomeVideoCard } from "../video/HomeVideoCard";
import { NewEpisodesLink } from "../newepisodes/NewEpisodesPage";
import { QuizBanner } from "../tastequiz/TasteQuizPage";
import { CvLeninCard } from "../catalog/CvLenin";
import { CvGoskino, CvNews, CvPlan } from "../catalog/CvExtras";

export function HomePage() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const name = session?.user.display_name || session?.user.username || "";
  const rows = useHomeRows();
  const hero = rows.data?.find((r) => r.key === "trending")?.items.find((m) => m.backdrop_path) ?? null;

  return (
    <div className="space-y-8">
      <Household name={name} />
      <CvNews />
      <CatalogPage>
        <div className="space-y-9 sm:space-y-11">
          <CvLeninCard />
          <CvPlan />
          <CvGoskino />
          <QuizBanner />
          <ContinueRow />
          <NewEpisodesLink />
          <RecoRow />
          <AskAiCard />
          <TvCard />
          <HomeVideoCard />
          <ForYouSection />
          <RatePrompt />
          <WatchlistRow />
          {rows.isPending ? (
            <>
              <div className="-mx-4 h-[420px] animate-pulse bg-surface sm:mx-0 sm:rounded-3xl" />
              <PosterRow title={t("catalog.row.trending")} loading />
              <PosterRow title={t("catalog.row.popular_movies")} loading />
            </>
          ) : rows.error ? (
            <CatalogError error={rows.error} onRetry={() => rows.refetch()} />
          ) : (
            <>
              {hero && <Hero item={hero} />}
              {rows.data.map((row) => (
                <PosterRow
                  key={row.key}
                  testId={`row-${row.key}`}
                  title={t(`catalog.row.${row.key}` as MessageKey)}
                  href={`/browse?${browseToParams({ mode: "list", list: row.list, kind: row.kind })}`}
                  items={row.items}
                />
              ))}
            </>
          )}
        </div>
      </CatalogPage>
    </div>
  );
}

function WatchlistRow() {
  const { t } = useI18n();
  const q = useProfileList("watchlist");
  return (
    <PosterRow
      testId="row-watchlist"
      title={t("lists.watchlist")}
      href="/lists/watchlist"
      items={q.data?.pages[0]?.items}
    />
  );
}

function Hero({ item }: { item: MediaSummary }) {
  const { t } = useI18n();
  return (
    <section className="home-hero relative -mx-4 overflow-hidden sm:mx-0 sm:rounded-3xl" aria-labelledby="hero-title">
      <Backdrop path={item.backdrop_path} title={item.title} eager />
      <div className="relative flex min-h-[440px] flex-col justify-end gap-3 px-5 pb-6 pt-24 sm:min-h-[460px] sm:max-w-2xl sm:px-10 sm:pb-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{t("catalog.row.trending")}</p>
        <h2 id="hero-title" className="text-3xl font-extrabold leading-tight drop-shadow sm:text-5xl">
          {item.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-text/80">
          <RatingBadge rating={item.rating} />
          {item.year && <span>{item.year}</span>}
          <span aria-hidden>·</span>
          <span>{t(`catalog.kind.${item.kind}` as MessageKey)}</span>
        </div>
        {item.overview && <p className="line-clamp-3 max-w-xl text-sm leading-relaxed text-text/85 sm:text-base">{item.overview}</p>}
        <div className="pt-1">
          <Link
            to={`/title/${item.id}`}
            className="inline-flex min-h-[44px] items-center rounded-xl bg-accent px-6 font-semibold text-on-accent transition hover:bg-accent-strong"
          >
            {t("catalog.details")}
          </Link>
        </div>
      </div>
    </section>
  );
}

/** Greeting plus a compact strip of paired TVs and profiles. */
function Household({ name }: { name: string }) {
  const { t } = useI18n();
  const { data: devices } = useDevices();
  const { data: profiles } = useProfiles();

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-center gap-3 lg:shrink-0">
        <MartyHello name={name} />
        <h1 className="sr-only">{t("home.welcome", { name })}</h1>
      </div>
      <div className="no-scrollbar -mx-4 flex min-w-0 items-center gap-2 overflow-x-auto px-4 lg:mx-0 lg:px-0">
        {/* Always first: adding another TV is one tap away, however many there are. */}
        <Link
          to="/pair"
          data-testid="home-pair-tv"
          className="flex min-h-[40px] shrink-0 items-center rounded-full bg-accent/15 px-3.5 text-sm font-semibold text-accent hover:bg-accent/25"
        >
          + {t("home.pair_cta")}
        </Link>
        {devices?.map((d) => (
          <Link
            key={d.id}
            to={d.online ? `/remote/${d.id}` : "/devices"}
            title={d.online ? t("common.online") : t("common.offline")}
            className="flex min-h-[40px] shrink-0 items-center gap-2 rounded-full border border-border bg-surface px-3.5 text-sm hover:border-muted"
          >
            <StatusDot online={d.online} />
            <span className="max-w-[10rem] truncate">{d.name}</span>
          </Link>
        ))}
        {!!profiles?.length && (
          <Link
            to="/profiles"
            aria-label={t("nav.profiles")}
            className="ml-1 flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface py-1 pl-1.5 pr-3.5 text-sm text-muted hover:border-muted"
          >
            <span className="flex -space-x-2">
              {profiles.slice(0, 4).map((p) => (
                <ProfileAvatar key={p.id} name={p.name} color={p.color} avatar={p.avatar} size={28} className="!rounded-full ring-2 ring-surface" />
              ))}
            </span>
            {t("nav.profiles")}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Cineko's mood: a sticker and a line that follow the time of day («Опять сериальчик?» at 2 am). */
function MartyHello({ name }: { name: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 5 * 60_000);
    return () => clearInterval(id);
  }, []);
  const m = martyMood(now);
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="marty-hello" data-mood={m.mood} data-line={m.key}>
      <Mascot size={64} mood={m.mood} animated />
      <div className="relative min-w-0 rounded-2xl rounded-bl-md lg:max-w-[26rem] border border-border bg-surface px-4 py-2.5 shadow-sm">
        <p className="text-lg font-bold leading-snug sm:text-xl">{t(m.key, { name: name || "" }).replace(/,\s*!/, "!")}</p>
      </div>
    </div>
  );
}
