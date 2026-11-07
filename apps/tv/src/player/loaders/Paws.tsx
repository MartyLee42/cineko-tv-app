// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { PawsArt } from "@martytv/ui/loaders/paws";
import { useCalmMotion } from "../../design/skins";
import { ArtLayout, pct, useStatus, type LoaderModel } from "../loaderParts";

/** «Следы лапок»: paw prints walk across the ground, one per 5 %; a stall makes the last one tap. */
export default function Paws({ m }: { m: LoaderModel }) {
  const calm = useCalmMotion();
  const { status } = useStatus(m);
  return (
    <ArtLayout m={m}>
      <PawsArt p={m.p} calm={calm} done={!!m.done} label={`${status} ${pct(m.p)}`} />
    </ArtLayout>
  );
}
