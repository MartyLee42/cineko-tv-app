// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { CatchArt } from "@martytv/ui/loaders/catch";
import { useCalmMotion } from "../../design/skins";
import { bindLoaderKeys } from "../loaderKeys";
import { ArtLayout, pct, useStatus, type LoaderModel } from "../loaderParts";

/** «Лови!»: Cineko catches pieces from four chutes (the arrows move the basket); the big number is the load. Previews play by themselves. */
export default function Catch({ m, preview = false }: { m: LoaderModel; preview?: boolean }) {
  const calm = useCalmMotion();
  const { status } = useStatus(m);
  return (
    <ArtLayout m={m}>
      <CatchArt p={m.p} calm={calm} done={!!m.done} demo={preview} quiet={preview} bindKeys={preview ? undefined : bindLoaderKeys} label={`${status} ${pct(m.p)}`} />
    </ArtLayout>
  );
}
