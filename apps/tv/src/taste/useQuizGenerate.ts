// «✨ Заполнить по моим фильмам» on the TV (Settings, next to the taste quiz):
// the questionnaire answers derived from the profile's history; pressing it
// again regenerates. Returns the action and the status line to show.
import { useState } from "react";
import { ApiError } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { quizGenSummary, useI18n } from "@martytv/ui";
import { quizApi, useQuizState } from "./data";

export function useQuizGenerate(profileId: string) {
  const { t, locale } = useI18n();
  const st = useQuizState();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const filled = Object.keys(st.data?.answers ?? {}).length > 0;

  const run = () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    quizApi
      .generate(profileId, catalogLang(locale))
      .then(
        (r) => setNote({ kind: "ok", text: quizGenSummary(r, t) }),
        (e: unknown) => setNote({ kind: "error", text: t(e instanceof ApiError && e.code === "not_enough_history" ? "quiz.gen.too_little" : "quiz.gen.failed") }),
      )
      .finally(() => setBusy(false));
  };

  return {
    action: { key: "quiz-generate", label: busy ? t("quiz.gen.busy") : t(filled ? "quiz.gen.refresh" : "quiz.gen.fill"), onPress: run },
    note,
  };
}
