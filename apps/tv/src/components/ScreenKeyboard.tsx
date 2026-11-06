// The on-screen keyboard (Search, «Уточнить поиск»): letter keys + space /
// delete / clear / layout switch, remote-navigable.
import { useI18n } from "@martytv/ui";
import { FocusButton, FocusSection } from "../focus";
import { KEYBOARD_COLS, LAYOUTS, otherLayout, type KeyAction, type Layout } from "../catalog/keyboard";

export const KEY = 80;
export const KEY_PITCH = 92;
export const KEYBOARD_WIDTH = KEYBOARD_COLS * KEY_PITCH;

/** Keys are focus keys `${prefix}-${key}` (e.g. kb-A, kb-space). */
export function ScreenKeyboard({
  focusKey = "kb",
  layout,
  onLayout,
  onAction,
}: {
  focusKey?: string;
  layout: Layout;
  onLayout: (l: Layout) => void;
  onAction: (a: KeyAction) => void;
}) {
  const { t } = useI18n();
  const keys = LAYOUTS[layout];
  const kbRows = Math.ceil(keys.length / KEYBOARD_COLS);
  const actions: { id: string; label: string; span: number; action: () => void }[] = [
    { id: `${focusKey}-space`, label: t("catalog.tv.kb.space"), span: 2, action: () => onAction({ type: "space" }) },
    { id: `${focusKey}-backspace`, label: `⌫ ${t("catalog.tv.kb.delete")}`, span: 2, action: () => onAction({ type: "backspace" }) },
    { id: `${focusKey}-clear`, label: t("catalog.tv.kb.clear"), span: 2, action: () => onAction({ type: "clear" }) },
    { id: `${focusKey}-layout`, label: layout === "en" ? "РУС" : "ENG", span: 1, action: () => onLayout(otherLayout(layout)) },
  ];
  let col = 0;
  return (
    <FocusSection focusKey={focusKey} className="relative" style={{ height: (kbRows + 1) * KEY_PITCH, width: KEYBOARD_WIDTH }}>
      {keys.map((k, i) => (
        <KbKey key={k} id={`${focusKey}-${k}`} left={(i % KEYBOARD_COLS) * KEY_PITCH} top={Math.floor(i / KEYBOARD_COLS) * KEY_PITCH} span={1} onPress={() => onAction({ type: "char", value: k })}>
          {k}
        </KbKey>
      ))}
      {actions.map((a) => {
        const left = col * KEY_PITCH;
        col += a.span;
        return (
          <KbKey key={a.id} id={a.id} left={left} top={kbRows * KEY_PITCH} span={a.span} small onPress={a.action}>
            {a.label}
          </KbKey>
        );
      })}
    </FocusSection>
  );
}

function KbKey({ id, left, top, span, small, onPress, children }: { id: string; left: number; top: number; span: number; small?: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute" style={{ left, top }}>
      <FocusButton focusKey={id} onPress={onPress} className={`tv-chip flex items-center justify-center rounded-control bg-surface-2 font-semibold ${small ? "text-2xl" : "text-4xl"}`}>
        <span className="block truncate text-center" style={{ width: span * KEY_PITCH - (KEY_PITCH - KEY), lineHeight: `${KEY}px` }}>
          {children}
        </span>
      </FocusButton>
    </div>
  );
}
