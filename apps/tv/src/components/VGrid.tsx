import { useEffect, useRef, useState, type ReactNode } from "react";
import { FocusContext, getCurrentFocusKey, useFocusable, type FocusableComponent } from "@noriginmedia/norigin-spatial-navigation";
import { clamp, gridNeighbor, gridPos, gridWindow, trackedIndex, type Direction } from "../catalog/virtual";
import { Slot } from "./HRow";

/**
 * A virtualized grid: renders only the rows around the focused one, at
 * computed positions. The parent scrolls it (translateY) from the reported
 * row so it can move headers along with it.
 */
export function VGrid<T>({
  focusKey,
  items,
  itemKey,
  cols,
  itemWidth,
  pitchX,
  pitchY,
  initialIndex = 0,
  rowsBefore = 2,
  rowsAfter = 3,
  onIndexChange,
  onSelect,
  onLongPress,
  renderItem,
}: {
  focusKey: string;
  items: readonly T[];
  itemKey: (item: T) => string;
  cols: number;
  itemWidth: number;
  pitchX: number;
  pitchY: number;
  initialIndex?: number;
  rowsBefore?: number;
  rowsAfter?: number;
  onIndexChange?: (index: number, item: T) => void;
  onSelect?: (item: T, index: number) => void;
  /** Holding OK (secondary action); without it OK acts on press. */
  onLongPress?: (item: T, index: number) => void;
  renderItem: (item: T, focused: boolean, index: number) => ReactNode;
}) {
  /** The focused item (index and key): when the list changes around it (a refresh, a video moving to another row, items added in front), the row/grid follows its key. */
  const [focus, setFocused] = useState<{ index: number; key: string | null }>(() => ({ index: clamp(initialIndex, 0, Math.max(0, items.length - 1)), key: null }));
  const keys = items.map(itemKey);
  const idx = trackedIndex(keys, focus.key, focus.index);
  // The focused item moved (the list changed under it): the parent's scroll follows.
  const moved = useRef(onIndexChange);
  const reported = useRef(idx);
  useEffect(() => {
    moved.current = onIndexChange;
  });
  useEffect(() => {
    if (idx === reported.current) return;
    reported.current = idx;
    if (!focus.key || getCurrentFocusKey() !== focus.key || !items[idx]) return;
    moved.current?.(idx, items[idx]!);
  }, [idx, focus.key, items]);
  const { ref, focusKey: key } = useFocusable({
    focusKey,
    saveLastFocusedChild: true,
    preferredChildFocusKey: keys[idx],
    measureChildrenLayout: false,
    nextFocusResolver: (direction: Direction, current: string, siblings: FocusableComponent[]) => {
      const i = keys.indexOf(current);
      const n = i < 0 ? null : gridNeighbor(i, items.length, cols, direction);
      return n === null ? null : (siblings.find((s) => s.focusKey === keys[n]) ?? null);
    },
  });
  const [start, end] = gridWindow(idx, items.length, cols, rowsBefore, rowsAfter);
  const rows = Math.ceil(items.length / cols);

  const slots: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    const { row, col } = gridPos(i, cols);
    slots.push(
      <Slot
        key={keys[i]}
        focusKey={keys[i]!}
        left={col * pitchX}
        top={row * pitchY}
        width={itemWidth}
        onFocus={() => {
          setFocused({ index: i, key: keys[i]! });
          reported.current = i;
          onIndexChange?.(i, item);
        }}
        onPress={() => onSelect?.(item, i)}
        onLongPress={onLongPress ? () => onLongPress(item, i) : undefined}
      >
        {(focused) => renderItem(item, focused, i)}
      </Slot>,
    );
  }
  return (
    <FocusContext.Provider value={key}>
      <div ref={ref} className="relative" style={{ height: rows * pitchY, width: cols * pitchX }}>
        {slots}
      </div>
    </FocusContext.Provider>
  );
}
