import type { ActivityItem } from "@martytv/contracts";

/** 0..1 playback position of an activity item, null when unknown. */
export function activityPercent(a: Pick<ActivityItem, "position_seconds" | "duration_seconds">): number | null {
  if (a.position_seconds == null || !a.duration_seconds) return null;
  return Math.min(1, Math.max(0, a.position_seconds / a.duration_seconds));
}
