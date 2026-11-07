// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { SpeedoArt } from "@martytv/ui/loaders/speedo";
import { useCalmMotion } from "../../design/skins";
import { ArtLayout, pct, useStatus, type LoaderModel } from "../loaderParts";

/** «Назад в будущее»: the speedometer climbs to 88 mph; fire trails as the film starts. */
export default function Speed88({ m }: { m: LoaderModel }) {
  const calm = useCalmMotion();
  const { status } = useStatus(m);
  return (
    <ArtLayout m={m}>
      <SpeedoArt p={m.p} calm={calm} done={!!m.done} label={`${status} ${pct(m.p)}`} />
    </ArtLayout>
  );
}
