// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
// Also what the «Метро» design always shows (loaderChunks.ts loaderKind).
import { useI18n, type MessageKey } from "@martytv/ui";
import type { LoaderModel } from "../loaderParts";
import { lampSeconds, stationOf } from "../loaderSteps";
import { HomageLayout, isDone } from "./homageParts";
import "./MetroTrain.css";

/** The route map's stations, one per load phase. */
const STATIONS: MessageKey[] = ["loaders2.metro_train.st1", "loaders2.metro_train.st2", "loaders2.metro_train.st3", "loaders2.metro_train.st4"];

const MAP_X = 460;
const MAP_W = 1000;

/**
 * «Поезд прибывает»: the view through a metro car's doors — tunnel lamps rush
 * past faster as the buffer fills; under it the car's route map, a station per
 * load phase, the train marker moving with the progress. At 100 % the doors
 * slide open onto the bright platform.
 */
export default function MetroTrain({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const at = done ? 3 : stationOf(m.stage);
  const lamp = { animationDuration: `${lampSeconds(m.p)}s` };
  const ground = <div className="lm-ground absolute left-0 top-0 h-full w-full" />;
  return (
    <HomageLayout m={m} name="metro_train" caption={t(done ? "loaders2.metro_train.done" : "loaders2.metro_train.caption")} backdrop={0} full={ground}>
      {/* The doors (760 × 400): behind them the platform, in their windows the tunnel. */}
      <div className="absolute overflow-hidden rounded-[22px]" style={{ left: 580, top: 40, width: 760, height: 400 }}>
        <div className="lm-platform absolute left-0 top-0 h-full w-full" />
        <div className={`lm-leaf lm-leaf-l ${done ? "lm-open-l" : ""}`}>
          <div className="lm-window">
            <div className="lm-lamps" style={lamp} />
          </div>
        </div>
        <div className={`lm-leaf lm-leaf-r ${done ? "lm-open-r" : ""}`}>
          <div className="lm-window">
            <div className="lm-lamps" style={lamp} />
          </div>
        </div>
      </div>
      {/* The route map over the doors' frame. */}
      <div className="absolute" style={{ left: MAP_X, top: 490, width: MAP_W, height: 110 }}>
        <span className="lm-line absolute left-0 top-[20px] block w-full" />
        <span className="lm-line-done hg-ease absolute left-0 top-[20px] block w-full origin-left" style={{ transform: `scaleX(${(done ? 1 : m.p).toFixed(3)})` }} />
        {STATIONS.map((key, i) => {
          const x = (MAP_W * i) / (STATIONS.length - 1);
          return (
            <div key={key} className="absolute" style={{ left: x - 80, top: 0, width: 160 }}>
              <span className={`lm-stop ${i <= at ? "lm-stop-passed" : ""}`} />
              <p className={`mt-3 truncate text-center text-[24px] ${i === at ? "font-bold text-text" : "text-muted"}`}>{t(key)}</p>
            </div>
          );
        })}
        <span className="lm-train hg-ease absolute top-[8px] block" style={{ transform: `translate3d(${Math.round(MAP_W * (done ? 1 : m.p)) - 22}px,0,0)` }} />
      </div>
    </HomageLayout>
  );
}
