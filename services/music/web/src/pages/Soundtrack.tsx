import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { ErrorBox, Loading } from "../ui";

interface SoundtrackResult {
  id: number;
  created: boolean;
  source: "album" | "ai" | "";
}

/**
 * /soundtrack/:media?lang= — opened from «Послушать саундтрек» on a Cineko
 * title: builds (or finds) the account's playlist for it, then opens it.
 */
export function SoundtrackPage() {
  const { media = "" } = useParams();
  const [params] = useSearchParams();
  const lang = params.get("lang") ?? "ru";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef("");

  useEffect(() => {
    const key = `${media}|${attempt}`;
    if (started.current === key) return; // StrictMode runs effects twice
    started.current = key;
    setError(null);
    api
      .post<SoundtrackResult>("/soundtrack", { media, lang })
      .then((r) => {
        void qc.invalidateQueries({ queryKey: ["library"] });
        navigate(`/my/${r.id}`, { replace: true });
      })
      .catch(setError);
  }, [media, lang, attempt, navigate, qc]);

  return (
    <div className="page">
      <h1>Саундтрек</h1>
      {error ? (
        <ErrorBox error={error} retry={() => setAttempt((n) => n + 1)} />
      ) : (
        <>
          <p className="muted">Собираем саундтрек: ищем альбомы с музыкой из фильма. Это может занять до минуты.</p>
          <Loading />
        </>
      )}
    </div>
  );
}
