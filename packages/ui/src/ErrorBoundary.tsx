import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { detectLocale, translate } from "./i18n";
import { reportError } from "./errors";

/** First component name from React's componentStack ("\n    at Foo (…)"). */
export function firstComponent(stack: string | null | undefined): string | undefined {
  if (!stack) return undefined;
  const m = /^\s*(?:at\s+)?([A-Za-z_$][\w$.]*)/m.exec(stack.replace(/^\s*\n/, ""));
  return m?.[1];
}

interface Props {
  children: ReactNode;
  variant?: "web" | "tv";
}

/**
 * Catches render crashes, reports them (kind "react") and shows a friendly
 * reload screen instead of a blank/black page. The fallback depends on
 * nothing but React (inline styles, locale read straight from storage).
 */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError("react", error, {
      component: firstComponent(info.componentStack),
      extra: info.componentStack ? { component_stack: info.componentStack.slice(0, 1200) } : undefined,
    });
  }

  render() {
    return this.state.failed ? <CrashScreen tv={this.props.variant === "tv"} /> : this.props.children;
  }
}

function reload() {
  try {
    window.location.reload();
  } catch {
    // nothing else to do
  }
}

function storedLocale() {
  try {
    return detectLocale(localStorage.getItem("martytv.locale"));
  } catch {
    return detectLocale(null);
  }
}

function CrashScreen({ tv }: { tv: boolean }) {
  const locale = storedLocale();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
    if (!tv) return;
    // Remote OK/Enter anywhere reloads (spatial navigation may be gone).
    const onKey = (e: KeyboardEvent) => {
      if (e.keyCode === 13 || e.key === "Enter") reload();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tv]);

  const text = "rgb(var(--mt-text, 242, 244, 248))";
  return (
    <div
      role="alert"
      data-testid="crash-screen"
      style={{
        position: tv ? "absolute" : "fixed",
        top: 0,
        left: 0,
        width: tv ? 1920 : "100%",
        height: tv ? 1080 : "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: tv ? 32 : 16,
        padding: 24,
        boxSizing: "border-box",
        textAlign: "center",
        background: "rgb(var(--mt-bg, 8, 9, 12))",
        color: text,
        fontFamily: "var(--mt-font-body, system-ui, sans-serif)",
        zIndex: 1000,
      }}
    >
      <div aria-hidden style={{ fontSize: tv ? 96 : 48, lineHeight: 1 }}>
        ⚠
      </div>
      <h1 style={{ margin: 0, fontSize: tv ? 64 : 24, fontWeight: 700 }}>{translate(locale, "errors.crash.title")}</h1>
      <p style={{ margin: 0, maxWidth: tv ? 1100 : 420, fontSize: tv ? 34 : 15, lineHeight: 1.45, color: "rgb(var(--mt-muted, 154, 160, 170))" }}>
        {translate(locale, "errors.crash.body")}
      </p>
      <button
        ref={button}
        type="button"
        onClick={reload}
        autoFocus
        style={{
          marginTop: tv ? 16 : 8,
          minHeight: tv ? 88 : 44,
          padding: tv ? "0 56px" : "0 24px",
          border: "none",
          borderRadius: 999,
          fontSize: tv ? 36 : 16,
          fontWeight: 600,
          cursor: "pointer",
          background: "rgb(var(--mt-accent, 200, 255, 61))",
          color: "rgb(var(--mt-on-accent, 10, 12, 6))",
          outline: tv ? "6px solid rgb(var(--mt-focus, 255, 255, 255))" : undefined,
          outlineOffset: 6,
        }}
      >
        {translate(locale, "errors.crash.reload")}
      </button>
    </div>
  );
}
