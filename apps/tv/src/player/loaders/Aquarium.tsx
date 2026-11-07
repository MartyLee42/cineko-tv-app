// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { AquariumArt } from "@martytv/ui/loaders/aquarium";
import { useCalmMotion } from "../../design/skins";
import { ArtLayout, pct, useStatus, type LoaderModel } from "../loaderParts";

/** «Аквариум»: pieces fall into Cineko's bowl as fish; full → he licks his lips and the bowl turns into ▶. */
export default function Aquarium({ m }: { m: LoaderModel }) {
  const calm = useCalmMotion();
  const { status } = useStatus(m);
  return (
    <ArtLayout m={m}>
      <AquariumArt p={m.p} calm={calm} done={!!m.done} label={`${status} ${pct(m.p)}`} />
    </ArtLayout>
  );
}
