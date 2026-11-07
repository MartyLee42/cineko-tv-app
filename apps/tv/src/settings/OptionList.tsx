// A remote-driven list of settings: Up/Down moves, Left/Right (or OK) changes
// the focused value, action rows run on OK. It handles keys itself (spatial
// navigation is paused while shown) so Left/Right never leaves the list.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";

export interface Choice<V> {
  value: V;
  label: string;
}

export type Row =
  | {
      kind: "choice";
      key: string;
      label: string;
      hint?: string;
      choices: Choice<unknown>[];
      value: unknown;
      onChange: (v: unknown) => void;
    }
  // A text value edited elsewhere (OK opens the editor); shown truncated.
  | { kind: "text"; key: string; label: string; hint?: string; value: string; empty: string; onOpen: () => void }
  | { kind: "header"; key: string; label: string; hint?: string }
  | { kind: "note"; key: string; label: string }
  | { kind: "actions"; key: string; actions: { key: string; label: string; primary?: boolean; onPress: () => void }[] };

export const focusable = (r: Row) => r.kind === "choice" || r.kind === "actions" || r.kind === "text";

/** Next value for a choice row (wraps around). */
export function cycle<V>(choices: readonly Choice<V>[], value: V, dir: 1 | -1): V {
  if (choices.length === 0) return value;
  const i = choices.findIndex((c) => c.value === value);
  const n = (Math.max(0, i) + dir + choices.length) % choices.length;
  return choices[i < 0 ? 0 : n]!.value;
}

/** Index of the next focusable row from `from` in `dir` (stays put at the ends). */
export function moveFocus(rows: readonly Row[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (focusable(rows[i]!)) return i;
  return from;
}

export function useOptionKeys({
  rows,
  initial,
  onBack,
  onFocusRow,
  nested = false,
}: {
  rows: Row[];
  initial?: string;
  onBack: () => void;
  onFocusRow?: (key: string) => void;
  /** Opened over another option list (which already paused spatial navigation). */
  nested?: boolean;
}) {
  const first = Math.max(0, rows.findIndex((r) => (initial ? r.key === initial : focusable(r))));
  const [index, setIndex] = useState(first);
  const [action, setAction] = useState(() => {
    const r = rows[first];
    return r?.kind === "actions" ? Math.max(0, r.actions.findIndex((a) => a.primary)) : 0;
  });
  const st = useRef({ rows, index, action, onBack, onFocusRow });
  useEffect(() => {
    st.current = { rows, index, action, onBack, onFocusRow };
  });
  const focusedKey = rows[index]?.key;
  useEffect(() => {
    if (focusedKey) st.current.onFocusRow?.(focusedKey);
  }, [focusedKey]);

  useEffect(() => {
    if (!nested) pauseNav();
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const { rows, index, action, onBack } = st.current;
      const row = rows[index];
      if (k === "back") return onBack();
      if (k === "up" || k === "down") {
        const n = moveFocus(rows, index, k === "up" ? -1 : 1);
        if (n !== index) {
          setIndex(n);
          const nr = rows[n];
          if (nr?.kind === "actions") setAction(Math.max(0, nr.actions.findIndex((a) => a.primary)));
        }
        return;
      }
      if (!row) return;
      if (row.kind === "choice") {
        if (k === "left" || k === "right" || k === "ok") row.onChange(cycle(row.choices, row.value, k === "left" ? -1 : 1));
      } else if (row.kind === "text") {
        if (k === "ok") row.onOpen();
      } else if (row.kind === "actions") {
        if (k === "left") setAction(Math.max(0, action - 1));
        else if (k === "right") setAction(Math.min(row.actions.length - 1, action + 1));
        else if (k === "ok") row.actions[action]?.onPress();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
      if (!nested) resumeNav();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `nested` is fixed for a list's lifetime
  }, []);

  // Rows can change (e.g. a step changes): keep the index on a focusable row.
  const safe = rows[index] && focusable(rows[index]!) ? index : moveFocus(rows, -1, 1);
  if (safe !== index && safe >= 0) setIndex(safe);
  return { index: safe, action, setIndex, setAction };
}

export const ROW_H = 96;
export const ROW_GAP = 14;

export function OptionRows({ rows, index, action, renderExtra }: { rows: Row[]; index: number; action: number; renderExtra?: (r: Row) => ReactNode }) {
  return (
    <>
      {rows.map((r, i) => {
        const focused = i === index;
        switch (r.kind) {
          case "header":
            return (
              <div key={r.key} className="pb-3 pt-8">
                <p className="text-3xl font-bold text-accent">{r.label}</p>
                {r.hint && <p className="mt-1 text-xl text-muted">{r.hint}</p>}
              </div>
            );
          case "note":
            return (
              <p key={r.key} className="pt-8 text-2xl leading-snug text-muted">
                {r.label}
              </p>
            );
          case "actions":
            return (
              <div key={r.key} data-row={r.key} className="flex pt-10">
                {r.actions.map((a, j) => (
                  <span
                    key={a.key}
                    data-action={a.key}
                    className={`tv-focus mr-6 rounded-control px-12 py-5 text-3xl font-semibold ${
                      focused && j === action ? "is-focused" : ""
                    } ${a.primary ? "bg-accent text-on-accent" : "bg-surface-2"}`}
                  >
                    {a.label}
                  </span>
                ))}
              </div>
            );
          case "text":
            return (
              <div
                key={r.key}
                data-setting={r.key}
                data-value={r.value}
                className={`tv-release flex items-center rounded-card px-10 ${focused ? "is-focused" : ""}`}
                style={{ height: ROW_H, marginBottom: ROW_GAP }}
              >
                <span className="shrink-0 text-3xl font-semibold">{r.label}</span>
                <span className={`ml-8 min-w-0 flex-1 truncate text-right text-2xl ${r.value ? (focused ? "text-text" : "text-muted") : "italic text-muted"}`}>
                  {r.value || r.empty}
                </span>
                <span className={`ml-4 text-2xl ${focused ? "text-accent" : "opacity-0"}`}>✎</span>
              </div>
            );
          case "choice": {
            const cur = r.choices.find((c) => c.value === r.value) ?? r.choices[0];
            return (
              <div
                key={r.key}
                data-setting={r.key}
                data-value={String(r.value)}
                className={`tv-release flex items-center rounded-card px-10 ${focused ? "is-focused" : ""}`}
                style={{ height: ROW_H, marginBottom: ROW_GAP }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-3xl font-semibold">{r.label}</span>
                </span>
                {renderExtra?.(r)}
                <span className={`ml-6 flex shrink-0 items-center text-3xl ${focused ? "text-text" : "text-muted"}`}>
                  <span className={`mr-4 text-2xl ${focused ? "text-accent" : "opacity-0"}`}>◀</span>
                  <span className="min-w-[200px] text-center font-semibold">{cur?.label}</span>
                  <span className={`ml-4 text-2xl ${focused ? "text-accent" : "opacity-0"}`}>▶</span>
                </span>
              </div>
            );
          }
        }
      })}
    </>
  );
}
