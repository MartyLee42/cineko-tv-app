// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useMemo } from "react";
import { useI18n } from "@martytv/ui";
import { Img } from "../../components/Img";
import { hashSeed, runtimeLabel, seeded } from "../homage";
import { pct, type LoaderModel } from "../loaderParts";
import { HomageLayout, isDone, useCachedDetail } from "./homageParts";
import "./Scanner.css";

/**
 * «Сканер цели»: the screen goes red, a reticle locks on the poster with a
 * scan line running over it and the HUD reads «ЦЕЛЬ: КИНО… АНАЛИЗ… 87 %».
 * At 100 %: «Я вернусь… через 1 ч 52 мин» (the cached runtime; plain without it).
 */
export default function Scanner({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const detail = useCachedDetail(m.seed);
  const rt = runtimeLabel(detail?.runtime);
  const hex = useMemo(() => {
    const rnd = seeded(hashSeed(`${m.seed}hud`));
    return Array.from({ length: 9 }, () => Math.floor(rnd() * 0xffffff).toString(16).toUpperCase().padStart(6, "0"));
  }, [m.seed]);
  const tint = (
    <div className="absolute left-0 top-0 h-full w-full">
      <Img src={m.backdrop ?? m.poster} className="ls-grey absolute left-0 top-0 h-full w-full object-cover" />
      <div className="ls-tint absolute left-0 top-0 h-full w-full" />
      <div className="ls-lines absolute left-0 top-0 h-full w-full" />
    </div>
  );
  return (
    <HomageLayout
      m={m}
      name="target_scan"
      backdrop={0}
      full={tint}
      className="ls-root"
      caption={done ? (rt ? t("loaders2.target_scan.done", { time: t(rt.key, rt.vars) }) : t("loaders2.target_scan.done_plain")) : `${t("loaders2.target_scan.analysis")} ${pct(m.p)}`}
    >
      <div className="ls-hud absolute left-[150px] top-[90px] w-[520px] text-[34px] leading-[1.45]">
        <p className="font-bold">{t("loaders2.target_scan.target")}</p>
        <p>
          {t("loaders2.target_scan.analysis")} <span className="tabular-nums">{pct(m.p)}</span>
        </p>
        <p className="hg-fade truncate" style={{ opacity: m.p > 0.5 ? 1 : 0 }}>
          {t("loaders2.target_scan.match", { title: (m.title || "…").toUpperCase() })}
        </p>
        <div className="mt-8 text-[26px] opacity-70">
          {hex.slice(0, 6).map((h, i) => (
            <p key={i} className={i === Math.floor(m.p * 6) % 6 ? "ls-blink" : ""}>
              {h} {(i * 37 + 11) % 100}
            </p>
          ))}
        </div>
      </div>
      <div className="absolute left-1/2 top-[50px] -ml-[190px] h-[520px] w-[380px]">
        <div className="absolute left-[30px] top-[20px] h-[480px] w-[320px] overflow-hidden">
          <Img src={m.poster} className="ls-grey absolute left-0 top-0 h-full w-full object-cover opacity-80" />
          <div className="ls-tint absolute left-0 top-0 h-full w-full" />
          {!done && <div className="ls-scan absolute left-0 top-0 h-[6px] w-full" />}
        </div>
        {["left-0 top-0 border-l-[6px] border-t-[6px]", "right-0 top-0 border-r-[6px] border-t-[6px]", "bottom-0 left-0 border-b-[6px] border-l-[6px]", "bottom-0 right-0 border-b-[6px] border-r-[6px]"].map((c) => (
          <span key={c} className={`ls-corner absolute block h-[70px] w-[70px] ${c} ${done ? "is-lock" : ""}`} />
        ))}
      </div>
      <div className="ls-hud absolute right-[150px] top-[90px] w-[420px] text-right text-[26px] leading-[1.6] opacity-70">
        {hex.slice(6).map((h, i) => (
          <p key={i}>{h}</p>
        ))}
        <p className="mt-6 text-[34px] font-bold opacity-100">{done ? "LOCK" : "SCAN"}</p>
      </div>
    </HomageLayout>
  );
}
