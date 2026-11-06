import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Recommendation } from "@martytv/contracts";
import { ProfileAvatar, useI18n } from "@martytv/ui";
import { realtime } from "../api";
import { Poster } from "../catalog/components";
import { CloseIcon } from "../icons";
import { RecoIcon } from "./icons";
import { recoKey, useRecoInbox, useUpdateReco } from "./queries";

// Toast for live `recommendation` events (module store, like admin messages).
let toast: Recommendation | null = null;
const listeners = new Set<() => void>();
function setToast(r: Recommendation | null) {
  toast = r;
  listeners.forEach((l) => l());
}

/** Realtime: a new recommendation refreshes the inbox and pops a toast; a reaction refreshes "sent". */
function useRecoEvents() {
  const qc = useQueryClient();
  useEffect(
    () =>
      realtime.on((env) => {
        if (env.type === "recommendation") {
          void qc.invalidateQueries({ queryKey: [...recoKey, "inbox"] });
          const r = env.payload as Recommendation | undefined;
          if (r?.id && r.media) setToast(r);
        } else if (env.type === "recommendation.reaction") {
          void qc.invalidateQueries({ queryKey: [...recoKey, "sent"] });
        }
      }),
    [qc],
  );
}

/** Header icon → /recommendations, with the unseen count; owns the live toast. */
export function RecoHeaderButton() {
  const { t } = useI18n();
  useRecoEvents();
  const unseen = useRecoInbox().data?.unseen ?? 0;
  return (
    <>
      <Link
        to="/recommendations"
        aria-label={unseen ? t("reco.unseen_badge", { n: unseen }) : t("reco.inbox")}
        title={t("reco.inbox")}
        data-testid="reco-button"
        className="relative flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted hover:bg-surface-2 hover:text-text"
      >
        <RecoIcon />
        {unseen > 0 && (
          <span
            data-testid="reco-badge"
            className="absolute right-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold leading-none text-on-accent ring-2 ring-bg"
          >
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </Link>
      {/* Portal: the header's backdrop-filter would otherwise contain the fixed toast. */}
      {createPortal(<RecoToast />, document.body)}
    </>
  );
}

function RecoToast() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const update = useUpdateReco();
  const r = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toast,
    () => null,
  );
  useEffect(() => {
    if (!r) return;
    const id = setTimeout(() => setToast(null), 10_000);
    return () => clearTimeout(id);
  }, [r]);
  if (!r) return null;
  const open = () => {
    setToast(null);
    update.mutate({ id: r.id, patch: { seen: true } });
    navigate(`/title/${r.media.id}`);
  };
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex justify-center px-3">
      <div
        role="status"
        data-testid="reco-toast"
        className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl border border-accent/40 bg-surface/95 p-3 shadow-2xl shadow-black/30 backdrop-blur"
      >
        <button type="button" onClick={open} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <Poster item={r.media} sizes="48px" className="w-12 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <ProfileAvatar name={r.from.name} color={r.from.color} avatar={r.from.avatar} size={22} className="!rounded-full" />
              <span className="font-semibold leading-snug">{t("reco.toast", { name: r.from.name, title: r.media.title })}</span>
            </span>
            {r.note && <span className="mt-1 line-clamp-3 block text-sm italic text-text/85">“{r.note}”</span>}
          </span>
        </button>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => setToast(null)}
          className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
