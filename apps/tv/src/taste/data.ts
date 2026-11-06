// Taste quiz API (contract: /profiles/{id}/taste-quiz…).
import { useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { useActiveProfileId } from "../profile/active";

export type QuizState = Schemas["TasteQuizState"];
export type QuizTitleAnswer = Schemas["TasteQuizTitleAnswer"];
export type MediaSummary = Schemas["MediaSummary"];

export const quizKey = (profile: string | null) => ["taste-quiz", profile] as const;

export function useQuizState() {
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: quizKey(profile),
    enabled: !!profile,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: (): Promise<QuizState> => unwrap(api.GET("/profiles/{id}/taste-quiz", { params: { path: { id: profile! } } })),
  });
}

export const quizApi = {
  state: (pid: string) => unwrap(api.GET("/profiles/{id}/taste-quiz", { params: { path: { id: pid } } })),
  titles: (pid: string, lang: "en" | "ru", limit = 10) =>
    unwrap(api.GET("/profiles/{id}/taste-quiz/titles", { params: { path: { id: pid }, query: { lang, limit } } })).then((r) => r.items),
  answer: (pid: string, body: { questions?: Record<string, string[]>; titles?: QuizTitleAnswer[] }) =>
    unwrap(api.POST("/profiles/{id}/taste-quiz/answers", { params: { path: { id: pid } }, body })).then((s) => {
      queryClient.setQueryData(quizKey(pid), s);
      return s;
    }),
  finish: (pid: string, lang: "en" | "ru") =>
    unwrap(api.POST("/profiles/{id}/taste-quiz/finish", { params: { path: { id: pid }, query: { lang } } })).then((r) => {
      queryClient.setQueryData(quizKey(pid), r.state);
      // Ratings / list / «Для вас» changed.
      void queryClient.invalidateQueries();
      return r;
    }),
  /** «✨ Заполнить по моим фильмам»: answers from the history (409 not_enough_history). */
  generate: (pid: string, lang: "en" | "ru") =>
    unwrap(api.POST("/profiles/{id}/taste-quiz/generate", { params: { path: { id: pid }, query: { lang } } })).then((r) => {
      queryClient.setQueryData(quizKey(pid), r.state);
      // «Для вас» is recomputed.
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "taste-quiz" });
      return r;
    }),
  dismiss: (pid: string) =>
    unwrap(api.POST("/profiles/{id}/taste-quiz/dismiss", { params: { path: { id: pid } } })).then((s) => {
      queryClient.setQueryData(quizKey(pid), s);
      return s;
    }),
};
