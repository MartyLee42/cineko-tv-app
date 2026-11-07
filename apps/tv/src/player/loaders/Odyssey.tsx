// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { OdysseyArt } from "@martytv/ui/loaders/odyssey";
import { useCalmMotion } from "../../design/skins";
import { ArtLayout, pct, useStatus, type LoaderModel } from "../loaderParts";

/** «Космическая одиссея»: the monolith rises as the sun and moon line up; one quiet note at 100 % (UI sounds on). */
export default function Odyssey({ m }: { m: LoaderModel }) {
  const calm = useCalmMotion();
  const { status } = useStatus(m);
  return (
    <ArtLayout m={m}>
      <OdysseyArt p={m.p} calm={calm} done={!!m.done} label={`${status} ${pct(m.p)}`} />
    </ArtLayout>
  );
}
