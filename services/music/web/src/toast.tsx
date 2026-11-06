import { useEffect, useState } from "react";

// A tiny global toast queue (usable outside React too).

interface Toast {
  id: number;
  text: string;
}

let seq = 0;
let items: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();

export function toast(text: string) {
  const t = { id: ++seq, text };
  items = [...items.slice(-2), t];
  listeners.forEach((l) => l(items));
  setTimeout(() => {
    items = items.filter((x) => x.id !== t.id);
    listeners.forEach((l) => l(items));
  }, 3200);
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
