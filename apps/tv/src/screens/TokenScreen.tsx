import { useRef, useState } from "react";
import { useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { unwrap } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { FocusButton } from "../focus";
import { defaultDeviceName, detectPlatform } from "../platform";

/**
 * Recovery / advanced setup: paste a device credential (mtd_…) or an API
 * token with the device:register scope (mtp_…), which is exchanged for a
 * device credential and then discarded.
 */
export function TokenScreen({ onPaired, onBack }: { onPaired: (credential: string) => void; onBack: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { ref, focused } = useFocusable({
    focusKey: "token-input",
    // OK on the field opens the TV's on-screen keyboard.
    onEnterPress: () => inputRef.current?.focus(),
    onBlur: () => inputRef.current?.blur(),
  });

  const submit = async () => {
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      if (token.startsWith("mtd_")) {
        await unwrap(api.GET("/devices/me", { headers: { Authorization: `Bearer ${token}` } }));
        onPaired(token);
      } else {
        const res = await unwrap(
          api.POST("/devices/register", {
            headers: { Authorization: `Bearer ${token}` },
            body: { name: defaultDeviceName(), platform: detectPlatform() },
          }),
        );
        onPaired(res.credential);
      }
    } catch {
      setError(t("tv.token.invalid"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col justify-center space-y-10 px-40">
      <h1 className="text-6xl font-bold">{t("tv.token.title")}</h1>
      <p className="max-w-[1300px] text-3xl text-muted">{t("tv.token.hint")}</p>
      <div ref={ref} className={`tv-focus rounded-2xl ${focused ? "is-focused" : ""}`}>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              inputRef.current?.blur();
              void submit();
            }
          }}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          placeholder="mtp_… / mtd_…"
          className="w-full rounded-2xl border-2 border-border bg-surface px-8 py-6 font-mono text-3xl text-text outline-none"
        />
      </div>
      {error && <p className="text-3xl text-danger">{error}</p>}
      <div className="flex space-x-6">
        <FocusButton focusKey="token-submit" onPress={submit} className="rounded-2xl bg-accent px-10 py-5 text-3xl font-semibold text-on-accent">
          {busy ? "…" : t("tv.token.submit")}
        </FocusButton>
        <FocusButton focusKey="token-back" onPress={onBack} autoFocus className="rounded-2xl bg-surface-2 px-10 py-5 text-3xl">
          {t("common.back")}
        </FocusButton>
      </div>
    </div>
  );
}
