import { useQuickHint } from "./store";

/** «•••» on the focused card of a row with quick actions (fades in, so fast scrolling doesn't flash it). */
export function QuickHint({ focused }: { focused: boolean }) {
  const on = useQuickHint();
  if (!on || !focused) return null;
  return (
    <span data-quick-hint aria-hidden className="tv-quick-hint absolute rounded-full bg-black/70 text-center text-[15px] font-bold leading-[24px] tracking-[1px] text-white shadow">
      •••
    </span>
  );
}
