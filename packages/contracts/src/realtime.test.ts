import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { backoffDelay, CommandError, RealtimeClient } from "./realtime";

/** Minimal in-memory WebSocket double. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: unknown[] = [];
  onopen?: () => void;
  onmessage?: (ev: { data: string }) => void;
  onclose?: (ev: { code: number; reason: string }) => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  // helpers
  open() {
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006, reason = "") {
    this.onclose?.({ code, reason });
  }
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

function client(extra: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  return new RealtimeClient({
    url: "ws://test/api/v1/ws",
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    minDelay: 100,
    maxDelay: 1000,
    random: () => 1,
    ...extra,
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("backoffDelay", () => {
  it("grows exponentially and caps", () => {
    const r = () => 1;
    expect(backoffDelay(0, 100, 1000, r)).toBe(100);
    expect(backoffDelay(1, 100, 1000, r)).toBe(200);
    expect(backoffDelay(3, 100, 1000, r)).toBe(800);
    expect(backoffDelay(10, 100, 1000, r)).toBe(1000);
    expect(backoffDelay(10, 100, 1000, () => 0)).toBe(100);
  });
});

describe("RealtimeClient", () => {
  it("authenticates with the first message and reports open on hello", () => {
    const rt = client({ getToken: () => "mtd_x" });
    const states: string[] = [];
    rt.onState((s) => states.push(s));
    rt.start();
    last().open();
    expect(last().sent[0]).toEqual({ type: "auth", payload: { token: "mtd_x" } });
    last().receive({ type: "hello" });
    expect(rt.state).toBe("open");
    expect(states).toEqual(["connecting", "open"]);
  });

  it("reconnects with backoff after a drop and flushes queued messages", () => {
    const rt = client();
    rt.start();
    last().receive({ type: "hello" });
    last().drop();
    expect(rt.state).toBe("closed");
    rt.send({ type: "device.state", payload: { screen: "home" } });
    vi.advanceTimersByTime(99);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    last().receive({ type: "hello" });
    expect(last().sent).toContainEqual({ type: "device.state", payload: { screen: "home" } });
  });

  it("reports auth failure after repeated policy-violation closes", () => {
    const onAuthFailed = vi.fn();
    const rt = client({ getToken: () => "bad", onAuthFailed });
    rt.start();
    last().drop(1008, "authentication required");
    expect(onAuthFailed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    last().drop(1008, "authentication required");
    expect(onAuthFailed).toHaveBeenCalledOnce();
  });

  it("treats a revocation close as auth failure", () => {
    const onAuthFailed = vi.fn();
    const rt = client({ onAuthFailed });
    rt.start();
    last().receive({ type: "hello" });
    last().drop(1000, "device revoked");
    expect(onAuthFailed).toHaveBeenCalledOnce();
  });

  it("replaces a silently dead socket (no pong for two pings)", () => {
    const c = client({ pingInterval: 1000 });
    c.start();
    const first = last();
    first.receive({ type: "hello" });
    expect(c.state).toBe("open");
    vi.advanceTimersByTime(1000);
    first.receive({ type: "pong" });
    // Server stops answering (TV standby killed the TCP link, no close event).
    vi.advanceTimersByTime(8000);
    expect(FakeSocket.instances.length).toBe(2);
    expect(c.state).toBe("connecting");
    last().receive({ type: "hello" });
    expect(c.state).toBe("open");
  });

  it("reconnectNow replaces a stale open socket but keeps a live one", () => {
    let t = 0;
    const c = client({ pingInterval: 25_000, now: () => t });
    c.start();
    last().receive({ type: "hello" });
    t = 10_000;
    c.reconnectNow();
    expect(FakeSocket.instances.length).toBe(1);
    // Woke up after standby: page visible again, nothing heard for minutes.
    t = 400_000;
    c.reconnectNow();
    expect(FakeSocket.instances.length).toBe(2);
    expect(c.state).toBe("connecting");
  });

  it("resolves commands with the TV's ack", async () => {
    const rt = client();
    rt.start();
    last().receive({ type: "hello" });
    const p = rt.command("dev-1", "device.show_message", { text: "hi" }, "cmd-1");
    expect(last().sent).toContainEqual({ id: "cmd-1", type: "device.show_message", target_device_id: "dev-1", payload: { text: "hi" } });
    last().receive({ id: "cmd-1", type: "ack", payload: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects failed acks with CommandError", async () => {
    const rt = client();
    rt.start();
    last().receive({ type: "hello" });
    const p = rt.command("dev-1", "media.pause", undefined, "c2");
    last().receive({ id: "c2", type: "ack", payload: { ok: false, error: "device_offline" } });
    await expect(p).rejects.toEqual(new CommandError("device_offline"));
  });

  it("retries a dropped command once with the same id", async () => {
    const rt = client();
    rt.start();
    last().receive({ type: "hello" });
    const p = rt.command("dev-1", "media.pause", undefined, "c3");
    last().drop();
    await vi.advanceTimersByTimeAsync(100);
    last().receive({ type: "hello" });
    const resent = last().sent.filter((m) => (m as { id?: string }).id === "c3");
    expect(resent).toHaveLength(1);
    last().receive({ id: "c3", type: "ack", payload: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });
});
