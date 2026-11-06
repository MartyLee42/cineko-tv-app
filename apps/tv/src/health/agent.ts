// TV health («Состояние»): reports this TV's load proxies to the server —
// ≈2 min after start, then every 10 min, plus once after a playback session
// (dropped frames). Each report samples ≤ 3 s, skips while the page is
// hidden, and nothing at all happens when the viewer switched it off
// (Settings → «Отправлять состояние ТВ», localStorage martytv.health_report).
import { useSyncExternalStore } from "react";
import type { Schemas } from "@martytv/contracts";
import { api } from "../api";
import { detectPlatform, storage } from "../platform";
import { player } from "../player/controller";
import { bridgeAvailable } from "../players/msx";
import { insideMsx } from "../players/select";
import { deviceModel } from "../settings/devicePrefs";
import { buildSample, FIRST_REPORT_MS, healthEnabled, healthGate, HEALTH_PREF_KEY, MIN_GAP_MS, QualityTracker, REPORT_EVERY_MS, type Measured } from "./logic";
import { LongTasks, measure, staticInfo, videoQuality } from "./sampler";

const STARTED = Date.now();
/** Read playback counters at most this often while playing. */
const QUALITY_EVERY_MS = 5000;

const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};

/** The on/off switch (default on). */
export const healthPref = {
  get: (): boolean => healthEnabled(storage.get(HEALTH_PREF_KEY)),
  set(on: boolean) {
    storage.set(HEALTH_PREF_KEY, on ? "1" : "0");
    if (on) wake();
    else sleep();
    bump();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** React: re-renders when the switch or the last report changes. */
export function useHealthPref(): boolean {
  useSyncExternalStore(healthPref.subscribe, () => version);
  return healthPref.get();
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPostAt: number | null = null;
let busy = false;
let screenOf: () => string | null = () => null;
const longTasks = new LongTasks();
const quality = new QualityTracker();
let lastQualityAt = 0;
/** A playback report waiting for the 1/min gap. */
let pendingPlayback: { dropped: number; total: number } | null = null;

const hidden = () => typeof document !== "undefined" && document.hidden === true;
const playing = () => player.flow.phase === "playing";

function model(): string | null {
  try {
    const ua = navigator.userAgent;
    return deviceModel(ua, insideMsx({ platform: detectPlatform(), msxAlive: bridgeAvailable(), ua })) || null;
  } catch {
    return null;
  }
}

/** The current screen for reports (set by App: home, details, player…). */
export function setHealthScreen(fn: () => string | null) {
  screenOf = fn;
}

function schedule(ms: number) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void report("periodic").finally(() => {
      if (started && healthPref.get()) schedule(REPORT_EVERY_MS);
    });
  }, ms);
}

function wake() {
  if (!started) return;
  longTasks.start();
  if (timer === null) schedule(lastPostAt === null ? FIRST_REPORT_MS : REPORT_EVERY_MS);
}

function sleep() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  longTasks.stop();
  quality.finish();
  pendingPlayback = null;
}

async function report(reason: "periodic" | "playback", frames: { dropped: number; total: number } | null = null): Promise<void> {
  if (busy) return;
  const gate = healthGate({ enabled: healthPref.get(), hidden: hidden(), now: Date.now(), lastPostAt });
  if (gate !== "ok") {
    if (gate === "too_soon" && reason === "playback" && frames) {
      pendingPlayback = frames;
      setTimeout(() => {
        const p = pendingPlayback;
        pendingPlayback = null;
        if (p) void report("playback", p);
      }, MIN_GAP_MS - (Date.now() - (lastPostAt ?? 0)) + 500);
    }
    return;
  }
  busy = true;
  try {
    const measured: Measured | null = await measure().catch(() => null);
    if (!healthPref.get()) return;
    const body = buildSample({
      reason,
      uptimeMs: Date.now() - STARTED,
      screen: safe(screenOf),
      playing: playing(),
      model: model(),
      info: staticInfo(),
      measured,
      longTasks: longTasks.read(),
      quality: frames,
    });
    const { response } = await api.POST("/devices/{id}/health", {
      params: { path: { id: "me" } },
      body: body as unknown as Schemas["DeviceHealthSample"],
    });
    if (response.ok || response.status === 429) lastPostAt = Date.now();
    if (response.ok) longTasks.reset();
    bump();
  } catch {
    // offline / older server: try again next time
  } finally {
    busy = false;
  }
}

function safe(fn: () => string | null): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function onPlayer() {
  if (!started || !healthPref.get()) return;
  if (playing()) {
    const t = Date.now();
    if (t - lastQualityAt < QUALITY_EVERY_MS) return;
    lastQualityAt = t;
    const v = player.video;
    quality.note(videoQuality(v), v);
  } else if (quality.active) {
    const q = quality.finish();
    if (q.total > 0) void report("playback", q);
  }
}

/** Starts the schedule (once, after sign-in). */
export function startHealth() {
  if (started) return;
  started = true;
  player.subscribe(onPlayer);
  if (healthPref.get()) wake();
}

/** Local values for «Об этом телевизоре» (measured on demand, never posted). */
export async function localHealth(): Promise<Record<string, unknown>> {
  const measured = await measure(2000).catch(() => null);
  return buildSample({
    reason: "periodic",
    uptimeMs: Date.now() - STARTED,
    screen: null,
    playing: false,
    model: null,
    info: staticInfo(),
    measured,
    longTasks: longTasks.read(),
    quality: null,
  });
}

/** When this TV last sent a report (null = not yet in this run). */
export function lastHealthPost(): number | null {
  return lastPostAt;
}
