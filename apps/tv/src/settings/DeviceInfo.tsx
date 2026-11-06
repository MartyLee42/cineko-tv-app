import { useEffect, useState } from "react";
import { healthHints, healthParts, parseDeviceModel, useI18n, type HealthValues } from "@martytv/ui";
import { localHealth, useHealthPref } from "../health/agent";
import { isBackKey } from "../platform";
import { engineProbe } from "../player/codecs";
import { playerKey } from "../player/keys";
import { platformApis, tvVolume, type SystemVolumeStatus } from "../player/volume";
import { claimKeys } from "../remote/keyOwner";

declare const __MARTYTV_RELEASE__: string;

/** What this TV's browser can decode (canPlayType / MediaSource). */
const CHECKS: { label: string; types: string[] }[] = [
  { label: "H.264", types: ['video/mp4; codecs="avc1.640028"'] },
  { label: "HEVC", types: ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"'] },
  { label: "VP9", types: ['video/webm; codecs="vp9"'] },
  { label: "AV1", types: ['video/mp4; codecs="av01.0.08M.08"'] },
  { label: "AAC", types: ['audio/mp4; codecs="mp4a.40.2"'] },
  { label: "AC3", types: ['audio/mp4; codecs="ac-3"'] },
  { label: "E-AC3", types: ['audio/mp4; codecs="ec-3"'] },
  { label: "DTS", types: ['audio/mp4; codecs="dtsc"'] },
  { label: "MKV", types: ["video/x-matroska", "video/webm"] },
  { label: "HLS", types: ["application/vnd.apple.mpegurl", "application/x-mpegURL"] },
];

function supported(types: string[]): "yes" | "maybe" | "no" {
  const p = engineProbe();
  let best: "yes" | "maybe" | "no" = "no";
  for (const t of types) {
    const r = p.canPlayType(t);
    if (r === "probably") return "yes";
    if (r === "maybe") best = "maybe";
    if (best === "no" && p.isTypeSupported?.(t)) best = "yes";
  }
  return best;
}

/** «Громкость ТВ: доступна / недоступна (нет разрешения)», plus which platform objects exist. */
function systemVolumeLine(s: SystemVolumeStatus, t: ReturnType<typeof useI18n>["t"]): string {
  const text =
    s === "ok"
      ? t("tvd.info.system_volume_ok")
      : s === "denied"
        ? t("tvd.info.system_volume_denied")
        : s === "absent"
          ? t("tvd.info.system_volume_absent")
          : t("tvd.info.system_volume_error", { error: s.slice("error:".length) });
  const apis = platformApis(window);
  const found = [apis.tizen && "tizen", apis.systeminfo && "systeminfo", apis.webapis && "webapis"].filter(Boolean);
  return found.length > 0 ? `${text} · ${found.join(", ")}` : text;
}

function chromeVersion(ua: string): string | null {
  const m = /Chrome\/(\d+)/.exec(ua);
  return m ? m[1]! : null;
}

/**
 * «Об этом телевизоре»: screen resolution and scale, model, browser engine,
 * codec support, network, memory, app version — handy for support and for
 * choosing releases (e.g. whether this TV decodes HEVC/AC3).
 */
export function DeviceInfo({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const [ping, setPing] = useState<number | null>(null);
  // «Состояние сейчас»: measured here on demand (≈2 s), never posted from here.
  const [health, setHealth] = useState<HealthValues | null>(null);
  const reporting = useHealthPref();
  // Re-probed on open (a privilege granted since start shows up here).
  const [sysVolume] = useState(() => tvVolume.probe());

  // Settings pauses spatial nav and listens in capture: claim the keys so
  // its handler steps aside while this screen is open (like the note editor).
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (k === "back" || k === "ok" || isBackKey(e) || e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (k) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, [onClose]);

  useEffect(() => {
    const t0 = Date.now();
    fetch("/healthz", { cache: "no-store" })
      .then(() => setPing(Date.now() - t0))
      .catch(() => setPing(-1));
  }, []);

  useEffect(() => {
    let alive = true;
    void localHealth()
      .then((h) => alive && setHealth(h as HealthValues))
      .catch(() => alive && setHealth({}));
    return () => {
      alive = false;
    };
  }, []);

  const ua = navigator.userAgent;
  const dpr = window.devicePixelRatio || 1;
  const vv = (window as unknown as { visualViewport?: { width: number; height: number } }).visualViewport;
  const viewW = Math.round(vv?.width || window.innerWidth);
  const viewH = Math.round(vv?.height || window.innerHeight);
  const scale = Math.min(viewW / 1920, viewH / 1080);
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string; downlink?: number } };
  const release = typeof __MARTYTV_RELEASE__ === "string" ? __MARTYTV_RELEASE__ : "dev";
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "—";
    }
  })();

  const rows: [string, string][] = [
    [t("tvd.info.screen"), `${screen.width}×${screen.height} × ${dpr} = ${Math.round(screen.width * dpr)}×${Math.round(screen.height * dpr)}`],
    [t("tvd.info.viewport"), `${viewW}×${viewH} · ${t("tvd.info.scale")} ${Math.round(scale * 100)}%`],
    [t("tvd.info.model"), parseDeviceModel(ua) || "—"],
    [t("tvd.info.engine"), chromeVersion(ua) ? `Chrome ${chromeVersion(ua)}` : "—"],
    [
      t("tvd.info.network"),
      [navigator.onLine ? t("common.online") : t("common.offline"), nav.connection?.effectiveType, nav.connection?.downlink ? `${nav.connection.downlink} Mbit/s` : null, ping == null ? "…" : ping < 0 ? "—" : `${t("tvd.info.ping")} ${ping} ms`]
        .filter(Boolean)
        .join(" · "),
    ],
    [t("tvd.info.app"), `${release} · ${location.host}`],
    [t("tvd.info.locale"), `${locale} · ${tz}`],
    [t("tvd.info.system_volume"), systemVolumeLine(sysVolume, t)],
  ];

  function healthLine() {
    if (!health) return t("health.measuring");
    const parts = healthParts(health, t, locale, { longTasks: true });
    const hints = healthHints(health);
    return (
      <>
        {parts.length === 0 && t("health.unavailable")}
        {parts.map((p, i) => (
          <span key={p.id} data-health={p.id} data-bad={p.bad ? "1" : undefined} className={p.bad ? "text-amber-300" : undefined}>
            {i > 0 ? " · " : ""}
            {p.text}
          </span>
        ))}
        {!reporting && <span className="font-normal text-muted"> · {t("health.reporting_off")}</span>}
        {hints.map((h) => (
          <span key={h} className="block text-[22px] font-normal text-amber-200">
            {t(h)}
          </span>
        ))}
      </>
    );
  }

  return (
    <div data-testid="tv-device-info" className="absolute left-0 top-0 z-40 h-full w-full bg-bg">
      <div className="absolute left-[120px] right-[120px] top-[70px]">
        <h1 className="text-6xl font-bold">{t("tvd.info.title")}</h1>
        <div className="mt-10 flex">
          <dl className="w-[960px]">
            {rows.map(([k, v]) => (
              <div key={k} className="tv-panel mb-3 flex rounded-2xl px-6 py-4 text-[28px]">
                <dt className="w-[320px] shrink-0 text-muted">{k}</dt>
                <dd className="min-w-0 truncate font-semibold">{v}</dd>
              </div>
            ))}
            <div className="tv-panel mb-3 flex rounded-2xl px-6 py-4 text-[28px]" data-testid="tv-device-health">
              <dt className="w-[320px] shrink-0 text-muted">{t("health.now")}</dt>
              <dd className="min-w-0 font-semibold leading-snug">{healthLine()}</dd>
            </div>
          </dl>
          <div className="ml-12 w-[560px]">
            <p className="mb-4 text-[28px] text-muted">{t("tvd.info.formats")}</p>
            <div>
              {CHECKS.map((c) => {
                const s = supported(c.types);
                return (
                  <span
                    key={c.label}
                    data-codec={c.label}
                    data-support={s}
                    className={`mb-3 mr-3 inline-block rounded-xl px-4 py-2 text-[26px] font-semibold ${
                      s === "yes" ? "bg-emerald-500/20 text-emerald-300" : s === "maybe" ? "bg-amber-500/20 text-amber-200" : "bg-rose-500/15 text-rose-300"
                    }`}
                  >
                    {s === "yes" ? "✓" : s === "maybe" ? "~" : "✕"} {c.label}
                  </span>
                );
              })}
            </div>
            <p className="mt-4 text-[22px] leading-snug text-muted">{t("tvd.info.formats_hint")}</p>
            <p className="mt-6 break-all text-[20px] leading-snug text-muted">{ua}</p>
          </div>
        </div>
        <p className="mt-8 inline-block rounded-2xl bg-surface-2 px-8 py-4 text-[28px] ring-4 ring-accent">{t("tvd.info.close")}</p>
      </div>
    </div>
  );
}
