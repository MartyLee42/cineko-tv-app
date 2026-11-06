import { describe, expect, it } from "vitest";
import { bufferStripe, netStats } from "./stats";

const speed = (b: number) => `${b} B/s`;
const mb = (b: number) => (b / 1e6).toFixed(1);

describe("netStats", () => {
  it("torrent: peers, peer speed, server load and the link to the TV", () => {
    const items = netStats({ torrent: { peers: 14, seeders: 9, download_speed_bps: 3_200_000 }, local: false, cpu: 12.4, streams: 2, device: { bps: 18_200_000, measured: true } }, speed, mb);
    expect(items.map((i) => i.id)).toEqual(["peers", "from_peers", "server", "device"]);
    expect(items[0]!.vars).toEqual({ peers: 14, seeders: 9 });
    expect(items[2]!.vars).toEqual({ cpu: 12, streams: 2 });
    expect(items[3]).toMatchObject({ key: "pstats.device", vars: { rate: "18.2" } });
  });
  it("a downloaded file plays from disk: no peers", () => {
    const items = netStats({ torrent: { peers: 1, seeders: 1, download_speed_bps: 0 }, local: true, cpu: null, streams: 1, device: null }, speed, mb);
    expect(items.map((i) => i.id)).toEqual(["local", "server"]);
    expect(items[1]!.key).toBe("pstats.server_streams");
  });
  it("online sources: no torrent parts; the usual rate is marked", () => {
    const items = netStats({ kind: "online", torrent: null, local: false, cpu: 5, streams: 1, device: { bps: 9_000_000, measured: false } }, speed, mb);
    expect(items.map((i) => i.id)).toEqual(["server", "device"]);
    expect(items[1]!.key).toBe("pstats.device_usual");
  });
  it("nothing known → nothing shown", () => {
    expect(netStats({ torrent: null, local: false, cpu: undefined, streams: undefined, device: null }, speed, mb)).toEqual([]);
  });
});

describe("bufferStripe", () => {
  it("ends at position + ahead, clamped", () => {
    expect(bufferStripe(100, 50, 1000)).toBe(15);
    expect(bufferStripe(990, 50, 1000)).toBe(100);
    expect(bufferStripe(10, null, 1000)).toBeNull();
    expect(bufferStripe(10, 5, null)).toBeNull();
  });
});
