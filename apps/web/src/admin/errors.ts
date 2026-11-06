import type { Schemas } from "@martytv/contracts";

export type ErrorGroup = Schemas["ClientErrorGroup"];
export type ErrorDetail = Schemas["ClientErrorDetail"];
export type ErrorSample = Schemas["ClientErrorSample"];
export type ErrorApp = Schemas["ClientErrorApp"];
export type ErrorKind = Schemas["ClientErrorKind"];

export const ERROR_APPS: ErrorApp[] = ["web", "tv", "api"];
export const ERROR_KINDS: ErrorKind[] = ["error", "unhandledrejection", "react", "api", "player", "console"];

export type TimeRange = "24h" | "7d" | "30d" | "all";
export const TIME_RANGES: TimeRange[] = ["24h", "7d", "30d", "all"];

const RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

/** The `since` query param for a time range (undefined = no limit). */
export function sinceFor(range: TimeRange, now = Date.now()): string | undefined {
  if (range === "all") return undefined;
  // Round to the minute so the query key stays stable between refetches.
  const t = Math.floor((now - RANGE_MS[range]) / 60_000) * 60_000;
  return new Date(t).toISOString();
}

const LAST_VIEWED_KEY = "martytv.admin.errors.last_viewed";

/** When the admin last opened the Errors tab (ISO), or null. */
export function readLastViewed(): string | null {
  try {
    const v = localStorage.getItem(LAST_VIEWED_KEY);
    return v && !Number.isNaN(Date.parse(v)) ? v : null;
  } catch {
    return null;
  }
}

export function writeLastViewed(iso: string): void {
  try {
    localStorage.setItem(LAST_VIEWED_KEY, iso);
  } catch {
    // storage unavailable: the badge just counts from "never"
  }
}

/** A group is "new" when it was first seen after the admin's previous visit. */
export function isNewGroup(g: Pick<ErrorGroup, "first_seen">, lastViewed: string | null): boolean {
  if (!lastViewed) return false;
  return Date.parse(g.first_seen) > Date.parse(lastViewed);
}

/** Plain-text report of a group for pasting into a bug report. */
export function groupAsText(group: ErrorGroup, samples: ErrorSample[]): string {
  const s = samples[0];
  const lines = [
    `[${group.app}/${group.kind}] ${group.message}`,
    "",
    `Status: ${group.status}${group.regressed ? " (regressed)" : ""}`,
    `Count: ${group.count} · users: ${group.users_affected} · devices: ${group.devices_affected}`,
    `First seen: ${group.first_seen}`,
    `Last seen: ${group.last_seen}`,
  ];
  if (group.last_release) lines.push(`Release: ${group.last_release}`);
  if (group.component) lines.push(`Component: ${group.component}`);
  if (group.top_frame) lines.push(`Top frame: ${group.top_frame}`);
  if (s) {
    lines.push("", `Latest sample (${s.occurred_at}):`);
    if (s.url) lines.push(`URL: ${s.url}`);
    if (s.release) lines.push(`Release: ${s.release}`);
    if (s.user) lines.push(`User: ${s.user.display_name || s.user.username}`);
    if (s.device) lines.push(`Device: ${s.device.name}`);
    if (s.device_model) lines.push(`Model: ${s.device_model}`);
    if (s.user_agent) lines.push(`User agent: ${s.user_agent}`);
    if (s.request_id) lines.push(`Request id: ${s.request_id}`);
    if (s.extra) lines.push(`Extra: ${JSON.stringify(s.extra)}`);
    if (s.stack) lines.push("", "Stack:", s.stack);
  }
  return lines.join("\n");
}

/** Copies text; falls back to a hidden textarea for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
