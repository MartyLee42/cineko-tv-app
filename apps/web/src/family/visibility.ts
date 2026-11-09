// «Кто видит чьи лайки» (Admin → Overview): pure helpers for the admin
// matrix (GET/PUT /admin/family-visibility). A cell (viewer, sharer) is the
// admin's override when set, else the sharer's share_with_family.
import type { Schemas } from "@martytv/contracts";

export type Visibility = Schemas["FamilyVisibility"];
export type VisProfile = Schemas["FamilyVisibilityProfile"];
export type VisChange = Schemas["FamilyVisibilityUpdate"]["changes"][number];

export interface Cell {
  /** What the viewer sees now. */
  visible: boolean;
  /** The admin's value, or null when the cell follows the default. */
  override: boolean | null;
  /** The sharer's share_with_family. */
  fallback: boolean;
}

export interface Account {
  userId: string;
  userName: string;
  profiles: VisProfile[];
}

const key = (viewer: string, sharer: string) => `${viewer}|${sharer}`;

export function overrideMap(v: Visibility): Map<string, boolean> {
  return new Map(v.overrides.map((o) => [key(o.viewer_profile_id, o.sharer_profile_id), o.allowed]));
}

export function cellOf(overrides: Map<string, boolean>, viewer: string, sharer: VisProfile): Cell {
  const o = overrides.get(key(viewer, sharer.profile_id));
  const override = o === undefined ? null : o;
  return { visible: override ?? sharer.share_with_family, override, fallback: sharer.share_with_family };
}

/** Profiles grouped by account, keeping the server's order. */
export function groupByAccount(profiles: VisProfile[]): Account[] {
  const out: Account[] = [];
  for (const p of profiles) {
    const last = out[out.length - 1];
    if (last && last.userId === p.user_id) last.profiles.push(p);
    else out.push({ userId: p.user_id, userName: p.user_name, profiles: [p] });
  }
  return out;
}

/** Pairs of a row (viewer fixed) or a column (sharer fixed), without the diagonal. */
export function linePairs(v: Visibility, line: { viewer: string } | { sharer: string }): [string, VisProfile][] {
  const byId = new Map(v.profiles.map((p) => [p.profile_id, p]));
  const out: [string, VisProfile][] = [];
  for (const p of v.profiles) {
    if ("viewer" in line) {
      if (p.profile_id !== line.viewer) out.push([line.viewer, p]);
    } else {
      const sharer = byId.get(line.sharer);
      if (sharer && p.profile_id !== line.sharer) out.push([p.profile_id, sharer]);
    }
  }
  return out;
}

/** Whole-line toggle: every cell visible → hide all, else show all (as overrides). */
export function toggleLine(v: Visibility, line: { viewer: string } | { sharer: string }): VisChange[] {
  const m = overrideMap(v);
  const pairs = linePairs(v, line);
  const allOn = pairs.length > 0 && pairs.every(([viewer, sharer]) => cellOf(m, viewer, sharer).visible);
  return pairs.map(([viewer, sharer]) => ({ viewer_profile_id: viewer, sharer_profile_id: sharer.profile_id, allowed: !allOn }));
}

/** Clears the line's overrides (back to defaults); empty when there are none. */
export function resetLine(v: Visibility, line: { viewer: string } | { sharer: string }): VisChange[] {
  const m = overrideMap(v);
  return linePairs(v, line)
    .filter(([viewer, sharer]) => m.has(key(viewer, sharer.profile_id)))
    .map(([viewer, sharer]) => ({ viewer_profile_id: viewer, sharer_profile_id: sharer.profile_id, allowed: null }));
}

/** Clears every override. */
export function resetAll(v: Visibility): VisChange[] {
  return v.overrides.map((o) => ({ viewer_profile_id: o.viewer_profile_id, sharer_profile_id: o.sharer_profile_id, allowed: null }));
}

/** One cell click: an explicit override of the opposite of what is visible now. */
export function toggleCell(v: Visibility, viewer: string, sharer: VisProfile): VisChange {
  const c = cellOf(overrideMap(v), viewer, sharer);
  return { viewer_profile_id: viewer, sharer_profile_id: sharer.profile_id, allowed: !c.visible };
}

/** The matrix after changes (optimistic update; the server's answer replaces it). */
export function applyChanges(v: Visibility, changes: VisChange[]): Visibility {
  const m = overrideMap(v);
  for (const c of changes) {
    const k = key(c.viewer_profile_id, c.sharer_profile_id);
    if (c.allowed === null) m.delete(k);
    else m.set(k, c.allowed);
  }
  const overrides = [...m].map(([k, allowed]) => {
    const [viewer_profile_id, sharer_profile_id] = k.split("|");
    return { viewer_profile_id: viewer_profile_id!, sharer_profile_id: sharer_profile_id!, allowed };
  });
  return { ...v, overrides };
}
