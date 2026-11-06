import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap } from "@martytv/contracts";
import { Centered, Logo, useI18n } from "@martytv/ui";
import { api, setCsrfToken } from "../api";
import { useSession } from "../session";
import { Button, Card, ErrorText, Field, Input } from "../components";

/** Only allow same-site relative redirects after login. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function LoginPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get("next"));

  if (session) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await unwrap(api.POST("/auth/login", { body: { username, password } }));
      setCsrfToken(res.csrf_token);
      await qc.invalidateQueries({ queryKey: ["session"] });
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_credentials" ? new Error(t("login.invalid")) : err,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Centered>
      <Logo className="mb-8 text-4xl" />
      <Card className="w-full max-w-sm text-left">
        <form onSubmit={submit} className="space-y-4">
          <h1 className="text-xl font-bold">{t("login.title")}</h1>
          <Field label={t("login.username")}>
            <Input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field label={t("login.password")}>
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <ErrorText error={error} />
          <Button type="submit" className="w-full" busy={busy}>
            {t("login.submit")}
          </Button>
        </form>
      </Card>
    </Centered>
  );
}
