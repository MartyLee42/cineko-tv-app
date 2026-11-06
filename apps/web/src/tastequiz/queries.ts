// «Давайте определим ваш вкус»: the taste quiz API for the active profile.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import type { MessageKey } from "@martytv/ui";
import { api } from "../api";
import { useActiveProfile } from "../watch/ActiveProfile";

export type QuizState = Schemas["TasteQuizState"];
export type QuizTitleAnswer = Schemas["TasteQuizTitleAnswer"];
export type QuizGenerated = Schemas["TasteQuizGenerated"];

/** Locale key of a question's option label. */
export const optionKey = (q: string, o: string) => (q.startsWith("genres_") ? `quiz.g.${o}` : `quiz.o.${q}.${o}`) as MessageKey;

export function useQuizState() {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["taste-quiz", profileId],
    queryFn: () => unwrap(api.GET("/profiles/{id}/taste-quiz", { params: { path: { id: profileId! } } })),
    enabled: !!profileId,
    staleTime: 5 * 60_000,
  });
}

export function useQuizApi() {
  const { profileId } = useActiveProfile();
  const qc = useQueryClient();
  const pid = profileId!;
  const put = (s: QuizState) => (qc.setQueryData(["taste-quiz", pid], s), s);
  return {
    titles: (lang: "en" | "ru", limit = 10) =>
      unwrap(api.GET("/profiles/{id}/taste-quiz/titles", { params: { path: { id: pid }, query: { lang, limit } } })).then((r) => r.items),
    answer: (body: { questions?: Record<string, string[]>; titles?: QuizTitleAnswer[] }) =>
      unwrap(api.POST("/profiles/{id}/taste-quiz/answers", { params: { path: { id: pid } }, body })).then(put),
    finish: (lang: "en" | "ru") =>
      unwrap(api.POST("/profiles/{id}/taste-quiz/finish", { params: { path: { id: pid }, query: { lang } } })).then((r) => {
        put(r.state);
        void qc.invalidateQueries();
        return r;
      }),
    /** «✨ Заполнить по моим фильмам»: answers from the history (409 not_enough_history). */
    generate: (lang: "en" | "ru") =>
      unwrap(api.POST("/profiles/{id}/taste-quiz/generate", { params: { path: { id: pid }, query: { lang } } })).then((r) => {
        put(r.state);
        // Taste and «Для вас» are recomputed.
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "taste-quiz" });
        return r;
      }),
    dismiss: () => unwrap(api.POST("/profiles/{id}/taste-quiz/dismiss", { params: { path: { id: pid } } })).then(put),
  };
}
