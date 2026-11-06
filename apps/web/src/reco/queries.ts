// Data for recommendations between people: inbox, sent, directory, mutations.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { api } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { useActiveProfile } from "../watch/ActiveProfile";
import { applyPatch, removeFromInbox, type Inbox, type RecoPatch } from "./logic";

export const recoKey = ["reco"] as const;

export function useDirectory(enabled = true) {
  return useQuery({
    queryKey: ["users-directory"],
    queryFn: async () => (await unwrap(api.GET("/users/directory"))).items,
    enabled,
    staleTime: 5 * 60_000,
  });
}

function inboxKey(lang: string, profileId: string | undefined) {
  return [...recoKey, "inbox", lang, profileId ?? null] as const;
}

export function useRecoInbox() {
  const lang = useCatalogLang();
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: inboxKey(lang, profileId),
    queryFn: () =>
      unwrap(api.GET("/recommendations/inbox", { params: { query: { lang, ...(profileId && { profile_id: profileId }) } } })),
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useRecoSent(enabled = true) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: [...recoKey, "sent", lang],
    queryFn: async () => (await unwrap(api.GET("/recommendations/sent", { params: { query: { lang } } }))).items,
    enabled,
    staleTime: 30_000,
  });
}

export function useRecommend() {
  const qc = useQueryClient();
  const lang = useCatalogLang();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: (body: { media_id: string; to_user_ids: string[]; note?: string }) =>
      unwrap(
        api.POST("/recommendations", {
          params: { query: { lang } },
          body: { ...body, ...(profileId && { from_profile_id: profileId }) },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...recoKey, "sent"] }),
  });
}

/** Updates every cached inbox (all langs/profiles) optimistically. */
function patchInboxes(qc: ReturnType<typeof useQueryClient>, fn: (d: Inbox) => Inbox) {
  qc.setQueriesData<Inbox>({ queryKey: [...recoKey, "inbox"] }, (d) => (d ? fn(d) : d));
}

export function useUpdateReco() {
  const qc = useQueryClient();
  const lang = useCatalogLang();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RecoPatch }) =>
      unwrap(api.PATCH("/recommendations/{id}", { params: { path: { id }, query: { lang } }, body: patch })),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: [...recoKey, "inbox"] });
      patchInboxes(qc, (d) => applyPatch(d, id, patch));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [...recoKey, "inbox"] }),
  });
}

/** Recipient dismisses / sender withdraws. */
export function useDeleteReco() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/recommendations/{id}", { params: { path: { id } } })),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: recoKey });
      patchInboxes(qc, (d) => removeFromInbox(d, id));
      qc.setQueriesData<{ id: string }[]>({ queryKey: [...recoKey, "sent"] }, (d) => d?.filter((r) => r.id !== id));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: recoKey }),
  });
}
