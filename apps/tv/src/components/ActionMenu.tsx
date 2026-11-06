import { useEffect, useRef, useState } from "react";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";

export interface MenuAction {
  key: string;
  label: string;
  primary?: boolean;
  onPress: () => void;
}

/**
 * A small modal list of actions (resume choice, episode options): ▲▼ move,
 * OK runs, Back cancels. Handles its own keys over whatever is behind.
 */
export function ActionMenu({
  title,
  subtitle,
  actions,
  initial = 0,
  onCancel,
  testId,
}: {
  title: string;
  subtitle?: string | null;
  actions: MenuAction[];
  initial?: number;
  onCancel: () => void;
  testId?: string;
}) {
  const [index, setIndex] = useState(initial);
  const st = useRef({ index, actions, onCancel });
  useEffect(() => {
    st.current = { index, actions, onCancel };
  });
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const { index, actions, onCancel } = st.current;
      if (k === "up" || k === "left") setIndex(Math.max(0, index - 1));
      else if (k === "down" || k === "right") setIndex(Math.min(actions.length - 1, index + 1));
      // A held OK (the long press that opened this menu) auto-repeats: ignore it.
      else if (k === "ok" || k === "play" || k === "playpause") {
        if (!e.repeat) actions[index]?.onPress();
      }
      else if (k === "back" || k === "stop") onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, []);
  return (
    // Fixed: covers the whole 1920×1080 canvas (#root is the containing block), side menu included.
    <div data-testid={testId} className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] items-center justify-center bg-black/60">
      <div className="w-[900px] rounded-card bg-surface px-16 py-14 shadow-2xl">
        <h2 className="line-clamp-2 text-5xl font-bold leading-tight">{title}</h2>
        {subtitle && <p className="mt-3 truncate text-3xl text-muted">{subtitle}</p>}
        <div className="mt-10">
          {actions.map((a, i) => (
            <div
              key={a.key}
              data-action={a.key}
              className={`tv-focus flex items-center ${i > 0 ? "mt-5" : ""} rounded-control px-10 py-6 text-4xl font-semibold ${i === index ? "is-focused" : ""} ${
                a.primary ? "bg-accent text-on-accent" : "bg-surface-2"
              }`}
            >
              {a.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
