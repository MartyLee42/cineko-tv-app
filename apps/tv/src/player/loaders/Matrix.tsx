// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useI18n } from "@martytv/ui";
import { RainBackground } from "../../design/looks/matrix";
import { pct, Status, type LoaderModel } from "../loaderParts";

const MX_CELLS = 40;

/** «Матрица»: «> Loading construct…», the percentage counting up in green and a block bar, over the digital rain. */
export default function MatrixLoader({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const mono = "'JetBrains Mono', ui-monospace, monospace";
  const filled = Math.round(m.p * MX_CELLS);
  return (
    <div data-testid="mx-loader" className="absolute left-0 top-0 h-full w-full" style={{ fontFamily: mono }}>
      <RainBackground />
      <div className="absolute left-[160px] top-[200px] w-[1600px] px-16 py-14" style={{ background: "rgba(0,6,2,.86)", boxShadow: "inset 0 0 0 2px rgba(0,255,65,.45), 0 0 60px rgba(0,255,65,.15)" }}>
        <p className="text-[34px] text-accent" style={{ textShadow: "0 0 10px rgba(0,255,65,.6)" }}>
          {"> "}
          {t("designs.matrix.loading")}
          <span className="mx-cursor ml-2 inline-block h-[34px] w-[18px] translate-y-[5px] bg-accent" />
        </p>
        <h1 className="mt-8 line-clamp-2 text-[72px] font-bold uppercase leading-[1.05]" style={{ color: "#c8ffd2", textShadow: "0 0 18px rgba(0,255,65,.65)" }}>
          {m.title || "…"}
        </h1>
        {m.episode && <p className="mt-3 truncate text-[34px] text-muted">{m.episode}</p>}
        <div className="mt-12 flex items-baseline gap-10">
          <span className="w-[260px] text-[120px] font-bold tabular-nums leading-none text-accent" style={{ textShadow: "0 0 24px rgba(0,255,65,.7)" }}>
            {pct(m.p)}
          </span>
          <span className="whitespace-pre text-[40px] leading-none tracking-[-.02em]" aria-hidden>
            <span className="text-accent">{"█".repeat(filled)}</span>
            <span style={{ color: "rgba(0,255,65,.22)" }}>{"░".repeat(MX_CELLS - filled)}</span>
          </span>
        </div>
        <Status m={m} className="mt-10 [&>p:first-child]:text-3xl" />
      </div>
    </div>
  );
}
