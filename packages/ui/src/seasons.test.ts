import { describe, expect, it } from "vitest";
import {
  activeSeason,
  civilDate,
  forcedState,
  rampIntensity,
  SEASON_TABLE,
  seasonState,
  greetingKey,
  maslenitsaWindow,
  orthodoxEaster,
  PRIORITY,
  seasonParam,
  seasonRender,
  SEASONS,
  seasonWindow,
  seasonWindows,
  ymdString,
  type SeasonInputs,
} from "./seasons";

/** Midday in Moscow (UTC+3) on a civil date. */
const msk = (s: string, time = "12:00") => new Date(`${s}T${time}:00+03:00`);

describe("orthodox easter", () => {
  it.each([
    [2024, "2024-05-05"],
    [2025, "2025-04-20"],
    [2026, "2026-04-12"],
    [2027, "2027-05-02"],
    [2028, "2028-04-16"],
    [2029, "2029-04-08"],
    [2030, "2030-04-28"],
  ])("%i → %s", (year, date) => {
    expect(ymdString(orthodoxEaster(year))).toBe(date);
  });

  it("is always a Sunday between Apr 4 and May 8 (2000–2099)", () => {
    for (let y = 2000; y < 2100; y++) {
      const e = orthodoxEaster(y);
      expect(new Date(Date.UTC(e.y, e.m - 1, e.d)).getUTCDay()).toBe(0);
      const md = e.m * 100 + e.d;
      expect(md).toBeGreaterThanOrEqual(404);
      expect(md).toBeLessThanOrEqual(508);
    }
  });
});

describe("maslenitsa", () => {
  it.each([
    // Forgiveness Sunday = Easter − 49 days; the week is Monday–Sunday.
    [2024, "2024-03-11", "2024-03-17"],
    [2025, "2025-02-24", "2025-03-02"],
    [2026, "2026-02-16", "2026-02-22"],
    [2027, "2027-03-08", "2027-03-14"],
    [2028, "2028-02-21", "2028-02-27"],
    [2029, "2029-02-12", "2029-02-18"],
    [2030, "2030-03-04", "2030-03-10"],
  ])("%i: %s – %s", (year, start, end) => {
    const w = maslenitsaWindow(year);
    expect(ymdString(w.start)).toBe(start);
    expect(ymdString(w.end)).toBe(end);
    expect(new Date(`${start}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${end}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it("runs from 4 days before the week through Forgiveness Sunday", () => {
    // 2025: week Feb 24 – Mar 2 → window Feb 20 – Mar 2 (Feb 23 is 23 Февраля's own day).
    expect(seasonState(msk("2025-02-19"))?.id).toBe("defender");
    expect(seasonState(msk("2025-02-23"))).toMatchObject({ id: "defender", main: true });
    expect(seasonState(msk("2025-02-24"))).toMatchObject({ id: "maslenitsa", main: true, intensity: 1 });
    expect(seasonState(msk("2025-03-02"))).toMatchObject({ id: "maslenitsa", main: true });
    expect(activeSeason(msk("2025-03-03"))).toBe(null);
    // 2030: week Mar 4–10 → lead from Feb 28; 8 Марта's own day wins inside the week.
    expect(seasonState(msk("2030-02-27"))).toBe(null);
    expect(seasonState(msk("2030-02-28"))).toMatchObject({ id: "maslenitsa", main: false, daysToMain: 4 });
    expect(seasonState(msk("2030-03-08"))).toMatchObject({ id: "women", main: true });
    expect(seasonState(msk("2030-03-09"))).toMatchObject({ id: "maslenitsa", main: true });
  });
});

describe("activeSeason", () => {
  it.each([
    ["2026-12-23", null],
    ["2026-12-24", "newyear"],
    ["2026-12-31", "newyear"],
    ["2027-01-01", "newyear"],
    ["2027-01-05", "newyear"],
    ["2027-01-06", "christmas"],
    ["2027-01-07", "christmas"],
    ["2027-01-08", "newyear"],
    ["2027-01-09", "oldnewyear"], // the snow carries on to Старый Новый год
    ["2027-01-14", "oldnewyear"],
    ["2027-01-15", null],
    ["2027-02-09", null],
    ["2027-02-10", "valentine"],
    ["2027-02-14", "valentine"],
    ["2027-02-15", null],
    ["2027-02-18", null],
    ["2027-02-19", "defender"],
    ["2027-02-23", "defender"],
    ["2027-03-03", null],
    ["2027-03-04", "women"], // 2027: Масленица's lead (from Mar 4) and the week (Mar 8–14)
    ["2027-03-08", "women"],
    ["2027-03-09", "maslenitsa"],
    ["2027-03-14", "maslenitsa"],
    ["2027-03-15", null],
    ["2027-04-07", null],
    ["2027-04-08", "cosmonautics"],
    ["2027-04-12", "cosmonautics"],
    ["2027-04-28", null],
    ["2027-04-29", "easter"], // Easter May 2 − 3 days
    ["2027-05-02", "easter"],
    ["2027-05-03", "easter"],
    ["2027-05-04", null],
    ["2027-05-05", "victory"],
    ["2026-04-08", "cosmonautics"], // 2026: Easter Apr 12 = Cosmonautics Day
    ["2026-04-09", "easter"], // Easter's lead (Apr 9) beats Cosmonautics' lead: priority
    ["2026-04-12", "easter"],
    ["2026-04-13", "easter"],
    ["2026-04-14", null],
    ["2026-05-04", null],
    ["2026-05-05", "victory"],
    ["2026-05-09", "victory"],
    ["2026-05-10", null],
    ["2026-06-07", null],
    ["2026-06-08", "russia"],
    ["2026-06-12", "russia"],
    ["2026-06-13", null],
    ["2026-08-27", null],
    ["2026-08-28", "knowledge"],
    ["2026-09-01", "knowledge"],
    ["2026-09-02", null],
    ["2026-10-26", null],
    ["2026-10-27", "halloween"],
    ["2026-10-31", "halloween"],
    ["2026-11-01", "halloween"],
    ["2026-11-02", null],
  ])("%s → %s", (date, id) => {
    expect(activeSeason(msk(date))).toBe(id);
  });

  it("marks main days, ramps up the lead days", () => {
    expect(seasonState(msk("2026-10-27"))).toEqual({ id: "halloween", main: false, daysToMain: 4, intensity: 0.45, year: 2026 });
    expect(seasonState(msk("2026-10-29"))).toMatchObject({ main: false, daysToMain: 2, intensity: 0.7 });
    expect(seasonState(msk("2026-10-30"))).toMatchObject({ main: false, daysToMain: 1, intensity: 0.85 });
    expect(seasonState(msk("2026-10-31"))).toMatchObject({ main: true, daysToMain: 0, intensity: 1 });
    expect(seasonState(msk("2026-11-01"))).toMatchObject({ main: false, daysToMain: 0, intensity: 1 }); // tail day
    expect(seasonState(msk("2026-12-24"))).toMatchObject({ id: "newyear", daysToMain: 7, intensity: 0.45, year: 2026 });
    expect(seasonState(msk("2027-01-01"))).toMatchObject({ id: "newyear", main: true, year: 2026 });
    expect(seasonState(msk("2027-01-04"))).toMatchObject({ id: "newyear", main: false, intensity: 1, year: 2026 });
    expect(seasonState(msk("2026-05-09"))).toMatchObject({ id: "victory", main: true });
    expect(seasonState(msk("2026-05-08"))).toMatchObject({ id: "victory", main: false });
    expect(rampIntensity(0)).toBe(1);
    expect(rampIntensity(10)).toBe(0.45);
  });

  it("uses the Moscow date at midnight", () => {
    // 20:59 UTC on Oct 26 = 23:59 in Moscow: not yet; 21:00 UTC = 00:00 Oct 27: Halloween's lead-up.
    expect(activeSeason(new Date("2026-10-26T20:59:59Z"))).toBe(null);
    expect(activeSeason(new Date("2026-10-26T21:00:00Z"))).toBe("halloween");
    // Halloween itself starts at Moscow midnight.
    expect(seasonState(new Date("2026-10-30T20:59:59Z"))?.main).toBe(false);
    expect(seasonState(new Date("2026-10-30T21:00:00Z"))?.main).toBe(true);
    // The New Year window ends at Jan 9 00:00 Moscow, Старый Новый год's lead takes over.
    expect(activeSeason(new Date("2027-01-08T20:59:59Z"))).toBe("newyear");
    expect(activeSeason(new Date("2027-01-08T21:00:00Z"))).toBe("oldnewyear");
    // Victory Day: May 9 in Moscow while it's still May 8 in UTC.
    expect(seasonState(new Date("2026-05-08T21:30:00Z"))?.main).toBe(true);
    expect(civilDate(new Date("2026-05-08T21:30:00Z"))).toEqual({ y: 2026, m: 5, d: 9 });
  });

  it("honours another time zone", () => {
    // 22:00 UTC Oct 26: Oct 27 in Moscow, still Oct 26 in New York.
    const t = new Date("2026-10-26T22:00:00Z");
    expect(activeSeason(t)).toBe("halloween");
    expect(activeSeason(t, "America/New_York")).toBe(null);
    expect(activeSeason(t, "UTC")).toBe(null);
  });

  it("keeps every window in one table and the priority covers all", () => {
    expect(SEASON_TABLE.map((r) => r.id).sort()).toEqual([...SEASONS].sort());
    expect(seasonWindows(2027).map((w) => w.id).sort()).toEqual([...SEASONS].sort());
    expect([...PRIORITY].sort()).toEqual([...SEASONS].sort());
    const ny = seasonWindow("newyear", 2026);
    expect([ymdString(ny.start), ymdString(ny.end), ymdString(ny.mainStart), ymdString(ny.mainEnd)]).toEqual(["2026-12-24", "2027-01-08", "2026-12-31", "2027-01-01"]);
    const ea = seasonWindow("easter", 2027);
    expect([ymdString(ea.start), ymdString(ea.end)]).toEqual(["2027-04-29", "2027-05-03"]);
    const ma = seasonWindow("maslenitsa", 2026);
    expect([ymdString(ma.start), ymdString(ma.mainStart), ymdString(ma.end)]).toEqual(["2026-02-12", "2026-02-16", "2026-02-22"]);
  });
});

describe("seasonRender", () => {
  const base: SeasonInputs = { season: "newyear", setting: "on", adminEnabled: true };
  it.each<[Partial<SeasonInputs>, string]>([
    [{}, "full"],
    [{ season: null }, "none"],
    [{ setting: "calm" }, "static"],
    [{ setting: "off" }, "none"],
    [{ adminEnabled: false }, "none"],
    [{ reducedMotion: true }, "static"],
    [{ calmMotion: true }, "static"],
    [{ playing: true }, "none"],
    [{ suppressed: true }, "none"],
    [{ season: "victory" }, "static"],
    [{ season: "victory", setting: "off" }, "none"],
    // A preview shows even when off / admin-disabled, still respects calm and playback.
    [{ preview: true, setting: "off" }, "full"],
    [{ preview: true, adminEnabled: false }, "full"],
    [{ preview: true, setting: "calm" }, "static"],
    [{ preview: true, reducedMotion: true }, "static"],
    [{ preview: true, playing: true }, "none"],
  ])("%o → %s", (patch, want) => {
    expect(seasonRender({ ...base, ...patch })).toBe(want);
  });
});

describe("helpers", () => {
  it("parses ?season=", () => {
    expect(seasonParam("?season=newyear")).toBe("newyear");
    expect(seasonParam("?a=1&season=maslenitsa")).toBe("maslenitsa");
    expect(seasonParam("?season=off")).toBe("off");
    expect(seasonParam("?season=xmas")).toBe(null);
    expect(seasonParam("")).toBe(null);
  });

  it("greets once per season window and phase (New Year's January days count for the December window)", () => {
    expect(greetingKey(seasonState(msk("2026-12-25"))!, "soon")).toBe("martytv.season_greeted.newyear.2026.soon");
    expect(greetingKey(seasonState(msk("2027-01-01"))!, "day")).toBe("martytv.season_greeted.newyear.2026.day");
    expect(greetingKey(seasonState(msk("2026-10-31"))!, "day")).toBe("martytv.season_greeted.halloween.2026.day");
    expect(forcedState("easter", msk("2026-10-29"))).toEqual({ id: "easter", main: true, daysToMain: 0, intensity: 1, year: 2026 });
  });
});
