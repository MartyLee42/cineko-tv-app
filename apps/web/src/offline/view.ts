// Device downloads: what a button / row says for an item (pure; tested).
import type { Locale, MessageKey } from "@martytv/ui";
import { formatBytes } from "../admin/format";
import { sourceErrorMessage } from "../play/releases";
import { percentOf, type DeviceStatus } from "./logic";
import type { DeviceItem } from "./items";

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type Tone = "idle" | "progress" | "wait" | "error" | "done";

export interface View {
  tone: Tone;
  /** Button / chip text. */
  label: string;
  /** 0…100 while downloading with a known size. */
  percent: number | null;
  /** Explanation under the button (errors, interruptions). */
  note: string | null;
  /** What a click does. */
  action: "start" | "open" | "retry" | "list";
}

type Item = Pick<DeviceItem, "status" | "bytes" | "total" | "mode" | "error" | "errorCode" | "errorVars" | "retryAt" | "autoResume">;

/** Why an item failed / paused, in words (null: nothing to explain). */
export function errorText(it: Item, t: TFn, locale: Locale): string | null {
  if (it.status === "paused") return it.autoResume ? t("devicedl.error.offline") : null;
  if (it.status !== "failed" || !it.error) return null;
  const v = it.errorVars ?? {};
  switch (it.error) {
    case "quota":
      return v.need != null && v.free != null
        ? t("devicedl.error.quota", { need: formatBytes(Number(v.need), locale), free: formatBytes(Number(v.free), locale) })
        : t("devicedl.error.quota_plain");
    case "storage":
      return t("devicedl.error.storage");
    case "format":
      return v.codec ? t("devicedl.error.format", { codec: String(v.codec) }) : t("devicedl.error.format_plain");
    case "network":
      return it.mode === "compat" ? t("devicedl.error.network_restart") : t("devicedl.error.network");
    case "offline":
      return t("devicedl.error.offline");
    case "source":
      return sourceErrorMessage(it.errorCode, t);
    case "no_releases":
      return t("devicedl.error.no_releases");
    case "expired":
      return t("devicedl.error.expired");
    case "server":
      return t("devicedl.error.server");
    case "incomplete":
      return t("devicedl.error.incomplete");
    default:
      return t("devicedl.error.failed");
  }
}

const TONE: Record<DeviceStatus, Tone> = {
  queued: "wait",
  preparing: "wait",
  downloading: "progress",
  paused: "wait",
  failed: "error",
  saved: "done",
};

export function deviceView(it: Item | null, t: TFn, locale: Locale, now: number): View {
  if (!it) return { tone: "idle", label: t("devicedl.save"), percent: null, note: null, action: "start" };
  const percent = percentOf(it);
  const note = errorText(it, t, locale);
  switch (it.status) {
    case "queued":
      return { tone: TONE.queued, label: t("devicedl.queued"), percent: null, note: null, action: "list" };
    case "preparing":
      return { tone: TONE.preparing, label: t("devicedl.preparing"), percent: null, note: null, action: "list" };
    case "downloading":
      return {
        tone: "progress",
        label: percent != null ? t("devicedl.downloading", { percent }) : t("devicedl.downloading_size", { size: formatBytes(it.bytes, locale) }),
        percent,
        note: null,
        action: "list",
      };
    case "paused":
      return {
        tone: "wait",
        label: percent ? t("devicedl.paused", { percent }) : t("devicedl.paused_plain"),
        percent,
        note,
        action: it.autoResume ? "list" : "retry",
      };
    case "failed": {
      const wait = it.retryAt ? Math.max(1, Math.ceil((it.retryAt - now) / 1000)) : null;
      return {
        tone: "error",
        label: wait != null ? t("devicedl.retrying", { s: wait }) : t("devicedl.failed"),
        percent,
        note,
        action: wait != null ? "list" : "retry",
      };
    }
    case "saved":
      return { tone: "done", label: t("devicedl.saved"), percent: 100, note: null, action: "open" };
  }
}

/** A season's items: how many are saved / still running. */
export function seasonState(items: readonly (Pick<DeviceItem, "status"> | null)[]): { total: number; saved: number; running: number; failed: number } {
  let saved = 0;
  let running = 0;
  let failed = 0;
  for (const it of items) {
    if (!it) continue;
    if (it.status === "saved") saved++;
    else if (it.status === "failed" || it.status === "paused") failed++;
    else running++;
  }
  return { total: items.length, saved, running, failed };
}
