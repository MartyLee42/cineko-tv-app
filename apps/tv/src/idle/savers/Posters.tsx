// «Афиша»: the titles the TV already loaded, one at a time — the backdrop
// slowly zooming behind, the poster and the name at a new spot each time, a
// cross-fade every POSTER_MS. OK opens the one on screen (IdleLayer asks
// `onShow` which it is). No extra requests: the query cache is the source.
import { useEffect, useMemo, useState } from "react";
import { imageUrl } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { queryClient, useCatalogConfig } from "../../catalog/queries";
import { Img } from "../../components/Img";
import { posterPool, type PosterItem } from "../logic";

export const POSTER_MS = 12_000;
/** Where the poster stands, in turn (left, right, centre-left, centre-right): never long in one place. */
const SPOTS = [180, 1260, 520, 920];

export function Posters({ onShow, hint }: { onShow?: (item: PosterItem | null) => void; hint: boolean }) {
  const { t } = useI18n();
  const cfg = useCatalogConfig();
  const pool = useMemo(() => posterPool(queryClient.getQueryCache().getAll().map((q) => q.state.data), Math.random), []);
  const [i, setI] = useState(0);
  const item = pool.length ? pool[i % pool.length]! : null;

  useEffect(() => {
    if (pool.length < 2) return;
    const id = setInterval(() => setI((n) => n + 1), POSTER_MS);
    return () => clearInterval(id);
  }, [pool.length]);
  useEffect(() => {
    onShow?.(item);
  }, [item, onShow]);
  useEffect(() => () => onShow?.(null), [onShow]);

  if (!item) return <div data-testid="saver-posters" className="absolute left-0 top-0 h-full w-full" />;
  const x = SPOTS[i % SPOTS.length]!;
  return (
    <div data-testid="saver-posters" data-poster-id={item.id} className="absolute left-0 top-0 overflow-hidden" style={{ width: 1920, height: 1080 }}>
      <div key={`bg-${i}`} className="ps-in absolute left-0 top-0 h-full w-full">
        <div className="ps-zoom absolute left-0 top-0 h-full w-full" style={{ opacity: 0.32 }}>
          <Img src={imageUrl(cfg.data, item.backdrop_path ?? item.poster_path, "w1280")} className="absolute left-0 top-0 h-full w-full object-cover" />
        </div>
        <div className="ps-shade absolute left-0 top-0 h-full w-full" />
        <div className="ps-float absolute" style={{ left: x, top: 150, width: 480 }}>
          <div className="relative overflow-hidden rounded-2xl" style={{ width: 480, height: 720, boxShadow: "0 30px 60px rgba(0,0,0,.6)" }}>
            <Img src={imageUrl(cfg.data, item.poster_path, "w500")} className="absolute left-0 top-0 h-full w-full object-cover" />
          </div>
          <p className="mt-6 text-center text-[40px] font-bold leading-tight text-white" style={{ textShadow: "0 2px 12px rgba(0,0,0,.8)" }}>
            {item.title}
          </p>
          {item.year ? <p className="mt-1 text-center text-[28px] text-white/70">{item.year}</p> : null}
        </div>
      </div>
      {hint && <p className="ps-hint absolute bottom-[40px] left-0 w-full text-center text-[24px] text-white/60">{t("idle.posters_hint")}</p>}
    </div>
  );
}
