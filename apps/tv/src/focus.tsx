import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import {
  doesFocusableExist,
  FocusContext,
  getCurrentFocusKey,
  setFocus,
  useFocusable,
  type FocusableComponent,
} from "@noriginmedia/norigin-spatial-navigation";
import { linearNext } from "./catalog/focusKeys";
import type { Direction } from "./catalog/virtual";
import type { RouteMemory } from "./catalog/nav";

/**
 * Records the focused element of the current screen (into its stack entry's
 * memory), so Back / menu navigation can restore it later.
 */
const FocusRecorder = createContext<((focusKey: string) => void) | null>(null);
export const FocusRecorderProvider = FocusRecorder.Provider;
export function useFocusRecorder() {
  return useContext(FocusRecorder);
}

/** A remote-focusable button. OK/Enter activates it; focus scales it up. */
export function FocusButton({
  focusKey,
  onPress,
  onFocus,
  children,
  className = "",
  focusedClassName = "",
  autoFocus,
}: {
  focusKey?: string;
  onPress: () => void;
  onFocus?: () => void;
  children: ReactNode;
  className?: string;
  /** Extra classes while focused (e.g. inverted colors for chips). */
  focusedClassName?: string;
  autoFocus?: boolean;
}) {
  const record = useFocusRecorder();
  const { ref, focused, focusSelf, focusKey: key } = useFocusable({
    focusKey,
    onEnterPress: onPress,
    onFocus: () => {
      record?.(key);
      onFocus?.();
    },
  });
  useEffect(() => {
    if (autoFocus) focusSelf();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={-1}
      onClick={onPress}
      className={`tv-focus ${focused ? `is-focused ${focusedClassName}` : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Groups focusables so focus returns to the last focused child when
 * navigating back into the section (focus retention).
 */
export function FocusSection({
  focusKey,
  children,
  className = "",
  style,
  boundary,
  preferredChildFocusKey,
  forceFocus,
}: {
  focusKey: string;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  boundary?: boolean;
  preferredChildFocusKey?: string;
  forceFocus?: boolean;
}) {
  const { ref, focusKey: key } = useFocusable({
    focusKey,
    saveLastFocusedChild: true,
    trackChildren: true,
    isFocusBoundary: boundary,
    preferredChildFocusKey,
    forceFocus,
  });
  return (
    <FocusContext.Provider value={key}>
      <div ref={ref} className={className} style={style}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}

/**
 * Resolver for containers whose children form an ordered line: moves by key
 * order instead of measuring DOM layout (cheap on slow TVs, and correct for
 * virtualized rows whose items are positioned off screen).
 */
export function lineResolver(keys: readonly string[], axis: "horizontal" | "vertical") {
  return (direction: Direction, focusKey: string, siblings: FocusableComponent[]): FocusableComponent | null => {
    const next = linearNext(keys, focusKey, direction, axis);
    return next ? (siblings.find((s) => s.focusKey === next) ?? null) : null;
  };
}

/**
 * A vertical (or horizontal) list of focusable sections navigated by key
 * order. Remembers the last focused section.
 */
export function FocusLine({
  focusKey,
  keys,
  preferred,
  axis = "vertical",
  children,
  className = "",
  style,
}: {
  focusKey: string;
  keys: readonly string[];
  preferred?: string;
  axis?: "horizontal" | "vertical";
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { ref, focusKey: key } = useFocusable({
    focusKey,
    saveLastFocusedChild: true,
    preferredChildFocusKey: preferred,
    nextFocusResolver: lineResolver(keys, axis),
    measureChildrenLayout: false,
  });
  return (
    <FocusContext.Provider value={key}>
      <div ref={ref} className={className} style={style}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}

/**
 * Focuses the remembered element of a screen once its content is ready
 * (returning from Details lands on the exact card), else `fallback()`.
 */
export function useInitialFocus(ready: boolean, mem: RouteMemory, fallback: () => string | undefined) {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const remembered = mem.focusKey;
    const target = remembered && doesFocusableExist(remembered) ? remembered : fallback();
    if (target) setFocus(target);
  });
}

/** Records the current focus in a screen's memory (before leaving it). */
export function rememberFocus(mem: RouteMemory) {
  const k = getCurrentFocusKey();
  if (k) mem.set("focusKey", k);
}

export { setFocus, doesFocusableExist, getCurrentFocusKey };

/**
 * Offset of `node` inside `ancestor` (layout only: transforms ignored), or
 * null when `ancestor` isn't on its offsetParent chain. Pages scrolled with a
 * transform use it to bring the focused section into view.
 */
export function offsetWithin(node: HTMLElement, ancestor: Element): number | null {
  let y = 0;
  let n: HTMLElement | null = node;
  while (n && n !== ancestor) {
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return n ? y : null;
}

/**
 * A focus container that reports its offset inside its parent whenever focus
 * enters it (layout is measured without transforms), so pages can scroll the
 * active section into view.
 */
export function FocusBlock({
  focusKey,
  onEnter,
  preferredChildFocusKey,
  children,
  className = "",
}: {
  focusKey: string;
  /** Focus entered: the block's offset in its parent element, and its node. */
  onEnter?: (offsetTop: number, node: HTMLElement) => void;
  preferredChildFocusKey?: string;
  children: ReactNode;
  className?: string;
}) {
  const { ref, focusKey: key } = useFocusable({
    focusKey,
    saveLastFocusedChild: true,
    preferredChildFocusKey,
    onFocus: (layout) => onEnter?.(layout.y, layout.node as HTMLElement),
  });
  return (
    <FocusContext.Provider value={key}>
      <div ref={ref} className={className}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}
