import { useState } from "react";
import type { Message } from "@martytv/contracts";
import { formatDate } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { FocusButton, FocusLine, useInitialFocus } from "../../focus";
import type { RouteMemory } from "../../catalog/nav";
import { ErrorState } from "../../components/States";
import { useDesign, useFrame } from "../../design/context";
import { useInbox, useMarkRead } from "../../design/data";
import { ScreenTitle } from "../../design/grid";
import { useReportDeep, useToTop } from "../../design/topJump";

/** Fixed card height + gap, so the list scrolls by computed offsets. */
const ITEM_H = 196;
const ITEM_PITCH = ITEM_H + 24;

/** Inbox of admin messages; OK marks the focused one read. */
export function MessagesScreen({ mem, onHome }: { mem: RouteMemory; onHome: () => void }) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const inbox = useInbox();
  const mark = useMarkRead();
  const items: Message[] = inbox.data?.items ?? [];
  const [idx, setIdx] = useState(() => mem.get<number>("idx") ?? 0);
  // Never park focus in the menu: an empty inbox focuses its own «Home» button.
  useInitialFocus(!inbox.isPending, mem, () => (items[0] ? `msg-${items[0].id}` : inbox.isError ? "msg-retry" : "msg-home"));
  // The focused card stays within the first three slots of the visible list.
  const scroll = Math.max(0, idx - 2) * ITEM_PITCH;
  const square = design === "terminal";
  useToTop(() => {
    setIdx(0);
    mem.set("idx", 0);
    return false;
  });
  useReportDeep(scroll > 0);

  return (
    <div data-testid="messages" className="absolute overflow-hidden" style={{ left: frame.x, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <div className="flex h-[136px] items-end pb-6">
        <ScreenTitle design={design} index={6}>
          {t("tvd.messages.title")}
        </ScreenTitle>
        {items.length > 0 && <span className="mb-1 ml-6 text-2xl text-muted">{t("tvd.messages.hint")}</span>}
      </div>
      {inbox.isError ? (
        <ErrorState focusKey="msg-retry" error={inbox.error} onRetry={() => void inbox.refetch()} />
      ) : items.length === 0 && !inbox.isPending ? (
        <div>
          <p className="text-[30px] text-muted">{t("tvd.messages.empty")}</p>
          <div className="mt-10 flex">
            <FocusButton focusKey="msg-home" onPress={onHome} className="rounded-control bg-surface-2 px-10 py-5 text-[28px] font-bold">
              {t("nav.home")}
            </FocusButton>
          </div>
        </div>
      ) : (
        <div className="absolute left-0 right-[96px] top-[150px] bottom-0 overflow-hidden">
          <FocusLine focusKey="msg-list" keys={items.map((m) => `msg-${m.id}`)} className="tv-track" style={{ transform: `translate3d(0,${-scroll}px,0)` }}>
            {items.map((m, i) => (
              <div key={m.id} className="mb-[24px] w-[1300px]" style={{ height: ITEM_H }}>
                <FocusButton
                  focusKey={`msg-${m.id}`}
                  onFocus={() => {
                    setIdx(i);
                    mem.set("idx", i);
                  }}
                  onPress={() => !m.read_at && mark.mutate(m.id)}
                  className={`tv-flat h-[196px] overflow-hidden bg-surface px-10 py-6 ${square ? "" : "rounded-card"}`}
                >
                  <div data-message-id={m.id} className="flex items-center text-[22px] text-muted">
                    {!m.read_at && <span className={`mr-4 bg-accent px-3 text-[18px] font-bold text-on-accent ${square ? "t-label" : "rounded-full"}`}>{t("tvd.messages.new")}</span>}
                    <span className="truncate">
                      {m.from_name ? t("tvd.messages.from", { name: m.from_name }) : ""}
                      {m.from_name ? " · " : ""}
                      {formatDate(m.created_at, locale)}
                    </span>
                  </div>
                  <p className="mt-2 truncate text-[32px] font-bold">{m.title}</p>
                  <p className="mt-2 line-clamp-2 text-[24px] leading-snug text-text/80">{m.body}</p>
                </FocusButton>
              </div>
            ))}
          </FocusLine>
        </div>
      )}
    </div>
  );
}
