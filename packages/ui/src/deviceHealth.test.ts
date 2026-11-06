import { describe, expect, it } from "vitest";
import { droppedPct, fmtNum, healthFlags, healthHints, healthParts, healthSeries, healthStale, pluralForm, sparkPoints, HEALTH_STALE_MS } from "./deviceHealth";
import { translate, type MessageKey } from "./i18n";

const tRu = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);
const tEn = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);

describe("device health", () => {
  it("formats the compact line in natural Russian", () => {
    const parts = healthParts(
      { heap_used_mb: 182.4, heap_limit_mb: 1024, device_memory_gb: 2, cores: 4, fps: 58.3, lag_ms: 12, dropped_frames: 12, total_frames: 3000 },
      tRu,
      "ru",
    );
    expect(parts.map((p) => p.text).join(" · ")).toBe("Память приложения 182 / 1024 МБ · ОЗУ ~2 ГБ · 4 ядра · 58 к/с · задержка 12 мс · пропущено кадров 0,4 %");
    expect(parts.every((p) => !p.bad)).toBe(true);
  });

  it("leaves out unknown values (old engines)", () => {
    expect(healthParts({ cores: 1, heap_used_mb: null }, tEn, "en").map((p) => p.text)).toEqual(["1 core"]);
    expect(healthParts({}, tEn, "en")).toEqual([]);
    expect(healthParts({ heap_used_mb: 50 }, tEn, "en")[0]!.text).toBe("App memory 50 MB");
  });

  it("flags bad values and gives hints", () => {
    const v = { fps: 22, lag_ms: 150, heap_used_mb: 900, heap_limit_mb: 1000, dropped_frames: 100, total_frames: 1000 };
    expect(healthFlags(v)).toMatchObject({ fps: true, lag: true, heap: true, dropped: true, slow: true, memory: true });
    expect(healthParts(v, tEn, "en").filter((p) => p.bad).map((p) => p.id)).toEqual(["heap", "fps", "lag", "dropped"]);
    expect(healthHints(v)).toEqual(["health.hint_slow", "health.hint_memory"]);
    expect(healthHints({ fps: 30, lag_ms: 100, heap_used_mb: 85, heap_limit_mb: 100 })).toEqual([]);
  });

  it("dropped share needs frames", () => {
    expect(droppedPct({ dropped_frames: 0, total_frames: 0 })).toBeNull();
    expect(droppedPct({ dropped_frames: 5, total_frames: 50 })).toBe(10);
  });

  it("numbers and plurals", () => {
    expect(fmtNum(0.44, "ru")).toBe("0,4");
    expect(fmtNum(2, "en")).toBe("2");
    expect(fmtNum(12.6, "en")).toBe("13");
    expect([1, 2, 5, 11, 21, 22, 12].map((n) => pluralForm("ru", n))).toEqual(["one", "few", "many", "many", "one", "few", "many"]);
    expect(pluralForm("en", 8)).toBe("many");
  });

  it("stale and series", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(healthStale(null, now)).toBe(true);
    expect(healthStale("2026-10-31T11:55:00Z", now)).toBe(false);
    expect(healthStale(new Date(now - HEALTH_STALE_MS - 1).toISOString(), now)).toBe(true);
    // History is newest first; the series goes oldest → newest.
    expect(healthSeries([{ fps: 60 }, { fps: null }, { fps: 30 }], "fps")).toEqual([30, 60]);
    expect(sparkPoints([30], 40, 10)).toBe("");
    expect(sparkPoints([30, 60, 45], 40, 10)).toBe("0,10 20,0 40,5");
  });
});
