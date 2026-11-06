import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { ApiError } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-strong",
  secondary: "bg-surface-2 text-text hover:bg-border",
  danger: "bg-danger/15 text-danger hover:bg-danger/25",
  ghost: "text-muted hover:text-text",
};

export function Button({
  variant = "primary",
  className = "",
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 py-2 font-semibold transition disabled:opacity-50 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-muted">{label}</span>
      {children}
      {error && <span className="block text-sm text-danger">{error}</span>}
    </label>
  );
}

const inputCls =
  "w-full min-h-[44px] rounded-xl border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-border bg-surface p-4 sm:p-5 ${className}`}>{children}</section>;
}

export function PageTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">{children}</h1>
      {action}
    </div>
  );
}

/** Human-readable message for any error thrown by the API layer. */
export function useErrorText() {
  const { t } = useI18n();
  return (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === "network_error") return t("common.network_error");
      if (err.code === "rate_limited") return t("common.rate_limited", { seconds: err.retryAfter ?? 60 });
      return err.message;
    }
    if (err instanceof Error && err.message) return err.message;
    return t("common.error");
  };
}

export function ErrorText({ error }: { error: unknown }) {
  const text = useErrorText();
  if (!error) return null;
  return (
    <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
      {text(error)}
    </p>
  );
}

export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError ? err.fields : {};
}

export function timeAgo(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}
