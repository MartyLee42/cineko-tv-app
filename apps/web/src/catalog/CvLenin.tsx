// «Конструктивизм» on the web: the «Рекомендуем к просмотру» poster card for
// «Ленин в Октябре» on Home (always there: the design does not let it be
// dismissed), and the «VOICE OF AMERICA» banner over «Видео».
import { Link } from "react-router";
import { SovietEmblem, useConstructivism, useI18n } from "@martytv/ui";
import { Poster } from "./components";
import { useLeninFilm } from "./lenin";

export function CvLeninCard() {
  const cv = useConstructivism();
  // No profile filters (see useLeninFilm): «Не интересно» / hidden-watched elsewhere never remove it.
  const film = useLeninFilm(cv);
  const { t } = useI18n();
  const m = film.data;
  if (!cv || !m) return null;
  return (
    <section data-testid="cv-lenin" data-media-id={m.id} aria-labelledby="cv-lenin-title" className="cv-lenin-web relative -mx-4 overflow-hidden sm:mx-0">
      <span className="cv-lenin-circle" aria-hidden />
      <span className="cv-lenin-wedge" aria-hidden />
      <SovietEmblem size={0} bg={null} className="cv-lenin-emblem" />
      <Link to={`/title/${m.id}`} className="relative flex gap-4 p-4 pr-12 sm:gap-7 sm:p-7 sm:pr-40 lg:pr-72">
        <Poster item={m} sizes="(min-width: 640px) 168px, 104px" className="w-[6.5rem] shrink-0 !rounded-none shadow-[6px_6px_0_#1a1512] sm:w-[10.5rem]" />
        <div className="flex min-w-0 flex-col justify-center gap-2 sm:gap-3">
          <p className="self-start bg-[#1a1512] px-2.5 py-0.5 font-display text-[11px] font-bold uppercase tracking-[0.2em] text-[#efe4cc] sm:text-sm">
            {t("designs.constructivism.recommend")}
          </p>
          <h2 id="cv-lenin-title" className="cv-monument origin-bottom-left -rotate-2 font-display text-[2rem] font-bold uppercase leading-[0.98] sm:text-6xl lg:text-7xl">
            {m.title}
          </h2>
          <p className="max-w-md text-sm leading-snug text-[#f8f0de]/90 sm:text-base">
            {m.year ? `${m.year} · ` : ""}
            {t("designs.constructivism.recommend_hint")}
          </p>
          <span className="mt-1 inline-flex min-h-[44px] items-center self-start bg-[#efe4cc] px-5 font-display text-base font-bold uppercase tracking-wider text-[#1a1512] sm:text-lg">
            {t("designs.constructivism.open")} →
          </span>
        </div>
      </Link>
    </section>
  );
}

/** «VOICE OF AMERICA» over «Видео» (decorative). */
export function CvVoiceOfAmerica() {
  if (!useConstructivism()) return null;
  return (
    <div data-testid="cv-voa" aria-hidden className="cv-voa-web pointer-events-none select-none">
      <span>Voice of America</span>
    </div>
  );
}
