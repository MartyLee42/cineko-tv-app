import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { useProfiles } from "../queries";
import { Button, Card, ErrorText, Field, Input, PageTitle, Select } from "../components";

type Pending = Schemas["PairingPending"];
type Outcome = "approved" | "denied" | null;

/** Formats free typing as ABCD-EFGH. */
function formatCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function PairPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { data: profiles } = useProfiles();
  const [code, setCode] = useState(() => formatCode(params.get("code") ?? ""));
  // The code being looked up. A scanned QR code (/pair?code=…) starts immediately.
  const [submitted, setSubmitted] = useState(() => (code.length === 9 ? code : ""));
  const [name, setName] = useState<string | null>(null);
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const lookup = useQuery({
    queryKey: ["pairing", submitted],
    enabled: submitted.length === 9,
    retry: false,
    staleTime: Infinity,
    queryFn: async (): Promise<Pending> => {
      try {
        return await unwrap(api.GET("/pairing/lookup", { params: { query: { code: submitted } } }));
      } catch (e) {
        throw e instanceof ApiError && e.status === 404 ? new Error(t("pair.not_found")) : e;
      }
    },
  });
  const pending = lookup.data ?? null;

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    setParams({ code });
    setSubmitted(code);
    if (code === submitted) void lookup.refetch();
  };

  const decide = async (approve: boolean) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        await unwrap(
          api.POST("/pairing/{id}/approve", {
            params: { path: { id: pending.pairing_id } },
            body: { name: (name ?? pending.device_name).trim(), ...(profileId ? { default_profile_id: profileId } : {}) },
          }),
        );
      } else {
        await unwrap(api.POST("/pairing/{id}/deny", { params: { path: { id: pending.pairing_id } } }));
      }
      setOutcome(approve ? "approved" : "denied");
      qc.invalidateQueries({ queryKey: ["devices"] });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 410 ? new Error(t("pair.expired")) : e);
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    return (
      <div className="mx-auto max-w-md">
        <PageTitle>{t("pair.title")}</PageTitle>
        <Card className="space-y-4 text-center">
          <div className="text-5xl">{outcome === "approved" ? "✓" : "✕"}</div>
          <p className="text-lg">{outcome === "approved" ? t("pair.done") : t("pair.denied")}</p>
          <Link to="/devices" className="inline-block text-accent hover:underline">
            {t("nav.devices")} →
          </Link>
        </Card>
      </div>
    );
  }

  if (pending) {
    return (
      <div className="mx-auto max-w-md">
        <PageTitle>{t("pair.confirm_title")}</PageTitle>
        <Card className="space-y-5">
          <div>
            <p className="text-sm text-muted">{t("pair.confirm_match")}</p>
            <p className="mt-2 rounded-xl bg-bg py-4 text-center font-mono text-4xl font-bold tracking-widest text-accent">
              {pending.user_code}
            </p>
          </div>
          <div className="space-y-1 text-sm text-muted">
            <p>
              {pending.device_name}
              {pending.platform ? ` · ${pending.platform}` : ""}
            </p>
            <p>{t("pair.requested_from", { ip: pending.ip })}</p>
          </div>
          <Field label={t("pair.device_name")}>
            <Input value={name ?? pending.device_name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("pair.default_profile")}>
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">{t("pair.no_default")}</option>
              {profiles?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorText error={error} />
          <div className="flex flex-col gap-2">
            <Button busy={busy} onClick={() => decide(true)}>
              {t("pair.approve")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => decide(false)}>
              {t("pair.deny")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <PageTitle>{t("pair.title")}</PageTitle>
      <Card>
        <form onSubmit={submitCode} className="space-y-4">
          <Field label={t("pair.enter_code")}>
            <Input
              value={code}
              onChange={(e) => setCode(formatCode(e.target.value))}
              placeholder="ABCD-EFGH"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              className="text-center font-mono text-2xl tracking-widest"
              autoFocus
            />
          </Field>
          <ErrorText error={lookup.error} />
          <Button type="submit" className="w-full" busy={lookup.isFetching} disabled={code.length !== 9}>
            {t("pair.find")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
