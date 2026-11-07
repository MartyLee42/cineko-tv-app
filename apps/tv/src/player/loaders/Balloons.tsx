// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { BalloonsArt } from "@martytv/ui/loaders/balloons";
import { useCalmMotion } from "../../design/skins";
import { ArtLayout, pct, useStatus, type LoaderModel } from "../loaderParts";

/** «Вверх»: balloons get tied to a little house; at 100 % it floats off. */
export default function Balloons({ m }: { m: LoaderModel }) {
  const calm = useCalmMotion();
  const { status } = useStatus(m);
  return (
    <ArtLayout m={m}>
      <BalloonsArt p={m.p} calm={calm} done={!!m.done} label={`${status} ${pct(m.p)}`} />
    </ArtLayout>
  );
}
