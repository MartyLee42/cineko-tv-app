import { describe, expect, it, vi } from "vitest";
import { fitInput, judgeFit } from "@martytv/media-types";
import type { Probe } from "./codecs";

vi.mock("../api", () => ({ api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn() }, realtime: { reconnectNow: () => undefined } }));

/** canPlayType that answers firmly ("probably") when the type contains any of `yes`. */
const probe = (yes: string[], answer = "probably"): Probe => ({ canPlayType: (t) => (yes.some((y) => t.includes(y)) ? answer : "") });

describe("tvCaps", () => {
  it("adds what the report can't carry (XviD, AVI) to known lists only", async () => {
    const { tvCaps } = await import("./fitCaps");
    const caps = tvCaps({ video: ["h264"], audio: ["aac"], containers: ["mkv"], compat: true }, probe(["avc1", "mp4v.20", "x-msvideo"]));
    expect(caps.video).toEqual(["h264", "mpeg4"]);
    expect(caps.containers).toEqual(["mkv", "avi"]);
    const xvid = { title: "Film.2004.DVDRip.XviD.avi", video_codec: "xvid", audio_codecs: ["aac"], resolution: "480p" };
    expect(judgeFit(fitInput(xvid), caps).verdict).toBe("ok");
    // XviD / MPEG-4 Part 2 counts only on a firm answer (a "maybe" decoded nothing on a Samsung).
    expect(tvCaps({ video: ["h264"], containers: ["mkv"] }, probe(["avc1", "mp4v.20"], "maybe")).video).toEqual(["h264"]);
    // Nothing detected stays unknown (never «unsupported»).
    expect(tvCaps({}, probe(["mp4v"])).video ?? null).toBe(null);
  });

  it("«Совместимый звук» off: no server conversion counted", async () => {
    const { tvCaps } = await import("./fitCaps");
    const auto = { video: ["h264"], audio: ["aac"], compat: true };
    const dts = { video_codec: "h264", audio_codecs: ["dts"] };
    expect(judgeFit(fitInput(dts), tvCaps(auto, probe(["avc1"]))).verdict).toBe("convert");
    expect(judgeFit(fitInput(dts), tvCaps(auto, probe(["avc1"]), true)).verdict).toBe("bad");
  });
});
