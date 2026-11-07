import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { detectLocale, translate } from "./i18n";
import { reportError } from "./errors";
import { isChunkLoadError } from "./chunkReload";

/** First component name from React's componentStack ("\n    at Foo (…)"). */
export function firstComponent(stack: string | null | undefined): string | undefined {
  if (!stack) return undefined;
  const m = /^\s*(?:at\s+)?([A-Za-z_$][\w$.]*)/m.exec(stack.replace(/^\s*\n/, ""));
  return m?.[1];
}

interface Props {
  children: ReactNode;
  variant?: "web" | "tv";
  /**
   * A lazy chunk that failed to download (a newer release replaced it):
   * resolves true when the page is reloading (chunkReload.ts). Meanwhile and
   * then «Обновляем приложение…» shows instead of the crash screen.
   */
  recover?: (error: unknown) => Promise<boolean>;
}

type State = { failed: boolean; updating: boolean };

/**
 * Catches render crashes, reports them (kind "react") and shows a friendly
 * reload screen instead of a blank/black page. The fallback depends on
 * nothing but React (inline styles, locale read straight from storage).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, updating: false };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const recover = this.props.recover;
    if (recover && isChunkLoadError(error)) {
      this.setState({ updating: true });
      void recover(error).then(
        (reloading) => !reloading && this.setState({ updating: false }),
        () => this.setState({ updating: false }),
      );
    }
    reportError("react", error, {
      component: firstComponent(info.componentStack),
      extra: info.componentStack ? { component_stack: info.componentStack.slice(0, 1200) } : undefined,
    });
  }

  render() {
    const tv = this.props.variant === "tv";
    if (this.state.updating) return <UpdatingScreen tv={tv} />;
    return this.state.failed ? <CrashScreen tv={tv} /> : this.props.children;
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

const screenStyle = (tv: boolean) =>
  ({
    position: tv ? "absolute" : "fixed",
    top: 0,
    left: 0,
    width: tv ? 1920 : "100%",
    height: tv ? 1080 : "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    boxSizing: "border-box",
    textAlign: "center",
    background: "rgb(var(--mt-bg, 8, 9, 12))",
    color: "rgb(var(--mt-text, 242, 244, 248))",
    fontFamily: "var(--mt-font-body, system-ui, sans-serif)",
    zIndex: 1000,
  }) as const;

/**
 * «Обновляем приложение…»: a newer release is loading (one reload, then the
 * app continues where it was). Calm on purpose: no warning sign, no button.
 */
export function UpdatingScreen({ tv }: { tv: boolean }) {
  const locale = storedLocale();
  return (
    <div role="status" data-testid="updating-screen" style={screenStyle(tv)}>
      <h1 style={{ margin: 0, fontSize: tv ? 56 : 22, fontWeight: 600 }}>{translate(locale, "appupdate.title")}</h1>
      <p style={{ margin: tv ? "28px 0 0" : "12px 0 0", maxWidth: tv ? 1100 : 420, fontSize: tv ? 32 : 15, lineHeight: 1.45, color: "rgb(var(--mt-muted, 154, 160, 170))" }}>
        {translate(locale, "appupdate.body")}
      </p>
    </div>
  );
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
