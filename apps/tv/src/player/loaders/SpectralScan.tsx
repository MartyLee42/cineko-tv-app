// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
// Also what the «Репликант» design always shows (loaderChunks.ts loaderKind).
import { useI18n } from "@martytv/ui";
import { Oscilloscope, SpectralBand } from "@martytv/ui/decor/replicant";
import type { LoaderModel } from "../loaderParts";
import { scanBloom, scanReveal } from "../loaderSteps";
import { HomageLayout, isDone } from "./homageParts";
import "./SpectralScan.css";

/**
 * «Спектральный скан»: a credits-black screen; a band of amber spectral bars lights up slice by
 * slice as the buffer fills, a scan line riding its edge; under it an oscilloscope trace whose
 * pink-and-cyan bloom swells with progress and opens fully at 100 %.
 */
export default function SpectralScan({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const reveal = scanReveal(m.p, done);
  const ground = <div className="ss-ground absolute left-0 top-0 h-full w-full" />;
  return (
    <HomageLayout m={m} name="spectral_scan" caption={t(done ? "loaders2.spectral_scan.done" : "loaders2.spectral_scan.caption")} backdrop={0.06} full={ground}>
      <p className="ss-credit absolute left-0 top-[40px] w-full text-center">Cineko · {t("loaders2.spectral_scan")}</p>
      <div className="absolute" style={{ left: 120, top: 104, width: 1680, height: 280 }}>
        <SpectralBand width={1680} height={280} reveal={reveal} />
        {!done && <span className="ss-cursor hg-ease absolute top-0 block h-full" style={{ transform: `translate3d(${Math.round(1680 * reveal)}px,0,0)` }} />}
      </div>
      <div className={`absolute ${done ? "ss-bloom-on" : ""}`} style={{ left: 0, top: 380, width: 1920, height: 240 }}>
        <Oscilloscope width={1920} height={240} bloom={scanBloom(m.p, done)} />
      </div>
    </HomageLayout>
  );
}
