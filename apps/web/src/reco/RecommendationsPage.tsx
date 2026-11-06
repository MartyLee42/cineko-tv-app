import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Recommendation } from "@martytv/contracts";
import { ProfileAvatar, Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { ErrorText, PageTitle, timeAgo } from "../components";
import { Poster, Tabs } from "../catalog/components";
import { CloseIcon } from "../icons";
import { REACTIONS, REACTION_EMOJI, nextReaction, type Reaction } from "./logic";
import { useDeleteReco, useRecoInbox, useRecoSent, useUpdateReco } from "./queries";

type Tab = "inbox" | "sent";

/** «Вам посоветовали» + «Вы посоветовали». */
export function RecommendationsPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "sent" ? "sent" : "inbox";
  const inbox = useRecoInbox();
  const unseen = inbox.data?.unseen ?? 0;
  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle>{t("reco.inbox")}</PageTitle>
      <div className="mb-5">
        <Tabs
          value={tab}
          label={t("reco.inbox")}
          onChange={(v) => setParams(v === "sent" ? { tab: "sent" } : {}, { replace: true })}
          options={[
            { value: "inbox", label: unseen ? `${t("reco.tab_received")} · ${unseen}` : t("reco.tab_received") },
            { value: "sent", label: t("reco.tab_sent") },
          ]}
        />
      </div>
      {tab === "inbox" ? <InboxList /> : <SentList />}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-2xl border border-dashed border-border px-4 py-12 text-center text-muted">{text}</p>;
}

function InboxList() {
  const { t } = useI18n();
  const q = useRecoInbox();
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorText error={q.error} />;
  if (!q.data.items.length) return <Empty text={t("reco.empty")} />;
  return (
    <ul className="space-y-3" data-testid="reco-inbox">
      {q.data.items.map((r) => (
        <li key={r.id}>
          <InboxCard r={r} />
        </li>
      ))}
    </ul>
  );
}

function useOpenTitle() {
  const navigate = useNavigate();
  const update = useUpdateReco();
  return (r: Recommendation) => {
    if (!r.seen_at) update.mutate({ id: r.id, patch: { seen: true } });
    navigate(`/title/${r.media.id}`);
  };
}

function CardShell({ r, unseen, children, testId }: { r: Recommendation; unseen?: boolean; children: ReactNode; testId: string }) {
  const open = useOpenTitle();
  const { t } = useI18n();
  return (
    <article
      data-testid={testId}
      data-unseen={unseen || undefined}
      className={`relative flex gap-3 rounded-2xl border p-3 sm:gap-4 sm:p-4 ${unseen ? "border-accent/50 bg-accent/[0.07]" : "border-border bg-surface"}`}
    >
      <button type="button" onClick={() => open(r)} className="w-20 shrink-0 self-start sm:w-24" aria-label={r.media.title}>
        <Poster item={r.media} sizes="96px" className="shadow-md shadow-black/20" />
      </button>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="pr-9">
          <button type="button" onClick={() => open(r)} className="text-left text-base font-bold leading-snug hover:text-accent-strong sm:text-lg">
            {r.media.title}
          </button>
          <p className="text-xs text-muted">
            {[r.media.year, t(`catalog.kind.${r.media.kind}` as MessageKey)].filter(Boolean).join(" · ")}
          </p>
        </div>
        {children}
      </div>
    </article>
  );
}

function Person({ p, label, time }: { p: Recommendation["from"]; label: string; time: string }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <ProfileAvatar name={p.name} color={p.color} avatar={p.avatar} size={24} className="!rounded-full" />
      <span className="min-w-0 pt-0.5 leading-snug">
        <span className="font-medium">{label}</span> <span className="whitespace-nowrap text-xs text-muted">· {time}</span>
      </span>
    </p>
  );
}

function Note({ text }: { text: string }) {
  if (!text) return null;
  return (
    <blockquote className="whitespace-pre-line border-l-2 border-accent/60 pl-3 text-sm italic leading-relaxed text-text/90" data-testid="reco-note-text">
      {text}
    </blockquote>
  );
}

function InboxCard({ r }: { r: Recommendation }) {
  const { t, locale } = useI18n();
  const update = useUpdateReco();
  const del = useDeleteReco();
  return (
    <CardShell r={r} unseen={!r.seen_at} testId="reco-card">
      <Person p={r.from} label={t("reco.from", { name: r.from.name })} time={timeAgo(r.created_at, locale)} />
      <Note text={r.note} />
      <div className="flex flex-wrap gap-1.5 pt-0.5" role="group" aria-label={t("reco.inbox")}>
        {REACTIONS.map((x) => (
          <ReactionButton
            key={x}
            reaction={x}
            on={r.reaction === x}
            onClick={() => update.mutate({ id: r.id, patch: { reaction: nextReaction(r.reaction, x) } })}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => del.mutate(r.id)}
        aria-label={t("reco.dismiss")}
        title={t("reco.dismiss")}
        data-testid="reco-dismiss"
        className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-text"
      >
        <CloseIcon />
      </button>
    </CardShell>
  );
}

function ReactionButton({ reaction, on, onClick }: { reaction: Reaction; on: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      data-testid={`reco-react-${reaction}`}
      className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition ${
        on ? "border-accent bg-accent/20 text-text" : "border-border bg-surface-2/60 text-text/90 hover:border-muted"
      }`}
    >
      <span aria-hidden>{REACTION_EMOJI[reaction]}</span>
      {t(`reco.${reaction}` as MessageKey)}
    </button>
  );
}

function SentList() {
  const { t } = useI18n();
  const q = useRecoSent();
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorText error={q.error} />;
  if (!q.data.length) return <Empty text={t("reco.sent_empty")} />;
  return (
    <ul className="space-y-3" data-testid="reco-sent">
      {q.data.map((r) => (
        <li key={r.id}>
          <SentCard r={r} />
        </li>
      ))}
    </ul>
  );
}

function SentCard({ r }: { r: Recommendation }) {
  const { t, locale } = useI18n();
  const del = useDeleteReco();
  const reaction = r.reaction as Reaction | null;
  return (
    <CardShell r={r} testId="reco-sent-card">
      <Person p={r.to} label={t("reco.to", { name: r.to.name })} time={timeAgo(r.created_at, locale)} />
      <Note text={r.note} />
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="reco-status">
        {reaction ? (
          <span className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-accent/60 bg-accent/20 px-3 font-medium text-text" data-testid="reco-reaction">
            <span aria-hidden>{REACTION_EMOJI[reaction]}</span>
            {t(`reco.${reaction}` as MessageKey)}
          </span>
        ) : (
          <span className="text-xs text-muted">{r.seen_at ? t("reco.seen") : t("reco.not_seen")}</span>
        )}
      </div>
      {r.reply && (
        <p className="flex items-start gap-2 text-sm">
          <ProfileAvatar name={r.to.name} color={r.to.color} avatar={r.to.avatar} size={20} className="!rounded-full mt-0.5" />
          <span className="rounded-2xl rounded-tl-sm bg-surface-2 px-3 py-1.5">{r.reply}</span>
        </p>
      )}
      <button
        type="button"
        onClick={() => del.mutate(r.id)}
        aria-label={t("reco.withdraw")}
        title={t("reco.withdraw")}
        className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-text"
      >
        <CloseIcon />
      </button>
    </CardShell>
  );
}
