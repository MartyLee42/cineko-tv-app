import { useEffect, useRef, useState, type ReactNode } from "react";
import { FocusContext, getCurrentFocusKey, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { lineResolver, useFocusRecorder } from "../focus";
import { clamp, rowWindow, trackedIndex, trackOffset } from "../catalog/virtual";
import { SkinEnd, useHasSkinEnd } from "../design/skins";

/** Room around the cards for the focus ring and scale-up (rows clip overflow). */
export const ROW_PAD = 24;
const LONG_PRESS_MS = 700;

/**
 * A horizontally scrolling, virtualized row. Only items around the focused
 * index are rendered; the track moves with a GPU transform. Items have a fixed
 * width, so positions are computed (no layout measuring while scrolling).
 */
export function HRow<T>({
  focusKey,
  items,
  itemKey,
  itemWidth,
  itemHeight,
  gap = 28,
  viewport = 1720,
  initialIndex = 0,
  before = 4,
  after = 8,
  pad = ROW_PAD,
  onIndexChange,
  onSelect,
  onLongPress,
  renderItem,
  tail: ownTail,
}: {
  focusKey: string;
  items: readonly T[];
  /** Focus key of an item; stable across remounts so focus can be restored. */
  itemKey: (item: T) => string;
  itemWidth: number;
  itemHeight: number;
  gap?: number;
  viewport?: number;
  initialIndex?: number;
  before?: number;
  after?: number;
  /** Room around the cards for the focus frame / scale (the row clips overflow). */
  pad?: number;
  onIndexChange?: (index: number, item: T) => void;
  onSelect?: (item: T, index: number) => void;
  /** Holding OK (secondary action); without it OK acts on press. */
  onLongPress?: (item: T, index: number) => void;
  renderItem: (item: T, focused: boolean, index: number) => ReactNode;
  /** Not focusable, after the last item (e.g. «loading more» / a load error), one item wide. */
  tail?: ReactNode;
}) {
  // Without a tail of its own the row ends with the skin's end card, if it has one («Конец фильма»).
  const hasEnd = useHasSkinEnd();
  const tail = ownTail ?? (hasEnd && items.length > 0 ? <SkinEnd kind="row" width={itemWidth} height={itemHeight} /> : null);
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
    nextFocusResolver: lineResolver(keys, "horizontal"),
    measureChildrenLayout: false,
  });
  const pitch = itemWidth + gap;
  const offset = trackOffset(idx, items.length + (tail ? 1 : 0), pitch, itemWidth, viewport);
  const [start, end] = rowWindow(idx, items.length, before, after, offset, pitch, viewport);

  const slots: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    slots.push(
      <Slot
        key={keys[i]}
        focusKey={keys[i]!}
        left={i * pitch}
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
      <div
        ref={ref}
        className="relative overflow-hidden"
        style={{ height: itemHeight + 2 * pad, marginLeft: -pad, marginRight: -pad, width: viewport + 2 * pad }}
      >
        <div className="tv-track absolute" style={{ left: pad, top: pad, transform: `translate3d(${-offset}px,0,0)` }}>
          {slots}
          {tail && end >= items.length && (
            <div className="absolute" style={{ left: items.length * pitch, top: 0, width: itemWidth }}>
              {tail}
            </div>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

export function Slot({
  focusKey,
  left,
  top = 0,
  width,
  onFocus,
  onPress,
  onLongPress,
  children,
}: {
  focusKey: string;
  left: number;
  top?: number;
  width: number;
  onFocus: () => void;
  onPress: () => void;
  onLongPress?: () => void;
  children: (focused: boolean) => ReactNode;
}) {
  const record = useFocusRecorder();
  // With a long-press action, OK acts on release (holding it = long press).
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; down: boolean; long: boolean }>({ down: false, long: false });
  useEffect(() => () => clearTimeout(hold.current.timer), []);
  const { ref, focused } = useFocusable({
    focusKey,
    onFocus: () => {
      record?.(focusKey);
      onFocus();
    },
    onEnterPress: () => {
      if (!onLongPress) return onPress();
      const h = hold.current;
      if (h.down) return;
      h.down = true;
      h.long = false;
      h.timer = setTimeout(() => {
        h.long = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onEnterRelease: () => {
      if (!onLongPress) return;
      const h = hold.current;
      clearTimeout(h.timer);
      const was = h.down;
      h.down = false;
      if (was && !h.long) onPress();
    },
  });
  return (
    <div ref={ref} data-focus-key={focusKey} onClick={onPress} className="absolute" style={{ left, top, width }}>
      {children(focused)}
    </div>
  );
}
