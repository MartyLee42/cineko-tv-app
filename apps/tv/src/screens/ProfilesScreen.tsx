import { useCallback, useEffect, useState } from "react";
import { qrDataUrl } from "./qr";
import { useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { ApiError, unwrap, type Profile } from "@martytv/contracts";
import { Logo, ProfileAvatar, Spinner, useI18n } from "@martytv/ui";
import { useDesign } from "../design/context";
import { api } from "../api";
import { FocusButton, FocusSection, setFocus } from "../focus";

/** "Who's watching?" grid with optional PIN entry. */
export function ProfilesScreen({
  profiles,
  initialProfileId,
  onSelect,
  onProfiles,
}: {
  profiles: Profile[];
  initialProfileId?: string | null;
  onSelect: (p: Profile) => void;
  /** The empty state refetched /profiles and found some. */
  onProfiles?: (profiles: Profile[]) => void;
}) {
  const { t } = useI18n();
  const design = useDesign();
  const [pinFor, setPinFor] = useState<Profile | null>(null);

  useEffect(() => {
    if (pinFor) return;
    const first = profiles.find((p) => p.id === initialProfileId) ?? profiles[0];
    if (first) void setFocus(`profile-${first.id}`);
  }, [profiles, initialProfileId, pinFor]);

  const choose = (p: Profile) => (p.has_pin ? setPinFor(p) : onSelect(p));

  if (pinFor) {
    return (
      <PinPad
        profile={pinFor}
        onCancel={() => {
          const id = pinFor.id;
          setPinFor(null);
          // Restore focus to the profile the PIN dialog was opened from.
          setTimeout(() => setFocus(`profile-${id}`), 0);
        }}
        onOk={() => onSelect(pinFor)}
      />
    );
  }

  return (
    <div className={`flex h-full flex-col items-center justify-center ${design === "terminal" ? "t-grid" : ""}`}>
      <Logo className="mb-14 text-[44px]" />
      <h1 className={`mb-16 ${design === "terminal" ? "t-label text-[44px]" : design === "projector" ? "p-wide text-[56px] font-bold uppercase" : "text-[60px] font-bold"}`}>{t("profiles.title")}</h1>
      {profiles.length === 0 ? (
        <NoProfiles onProfiles={onProfiles} />
      ) : (
        <FocusSection focusKey="profiles" className="-m-7 flex flex-wrap justify-center">
          {profiles.map((p) => (
            <ProfileTile key={p.id} profile={p} onPress={() => choose(p)} />
          ))}
        </FocusSection>
      )}
    </div>
  );
}

const EMPTY_POLL = 10_000;

/**
 * Zero profiles: profiles are created on the phone, so show where (address +
 * QR) and refetch on "Refresh" and every 10 s until one appears.
 */
function NoProfiles({ onProfiles }: { onProfiles?: (profiles: Profile[]) => void }) {
  const { t } = useI18n();
  const url = `${location.origin}/profiles`;
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    qrDataUrl(url, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then((d) => live && setQr(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await unwrap(api.GET("/profiles"));
      if (r.items.length > 0) onProfiles?.(r.items);
    } catch {
      // offline: the next poll retries
    } finally {
      setBusy(false);
    }
  }, [onProfiles]);

  useEffect(() => {
    const id = setInterval(() => void refresh(), EMPTY_POLL);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div data-testid="no-profiles" className="flex max-w-[1300px] items-center">
      {qr && <img src={qr} alt="" width={320} height={320} className="mr-16 shrink-0 rounded-2xl bg-white p-3" />}
      <div>
        <p className="text-4xl font-semibold">{t("profiles.empty")}</p>
        <p className="mt-6 text-3xl leading-snug text-muted">{t("remote.tv.no_profiles_hint")}</p>
        <p className="mt-6 break-all font-mono text-4xl text-accent">{url}</p>
        <div className="mt-12 flex items-center">
          <FocusButton focusKey="profiles-refresh" autoFocus onPress={() => void refresh()} className="rounded-2xl bg-accent px-10 py-5 text-3xl font-semibold text-on-accent">
            {t("remote.tv.refresh")}
          </FocusButton>
          {busy && (
            <span className="ml-8 text-muted">
              <Spinner size={40} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ProfileTile({ profile, onPress }: { profile: Profile; onPress: () => void }) {
  const { ref, focused } = useFocusable({ focusKey: `profile-${profile.id}`, onEnterPress: onPress });
  const design = useDesign();
  // Кинозал / Проектор: round avatars (Lampa-like); Терминал: square.
  const shape = design === "terminal" ? "rounded-none" : "rounded-full";
  return (
    <div ref={ref} onClick={onPress} className="m-7 flex w-56 flex-col items-center space-y-6">
      <div className={`tv-focus ${shape} ${focused ? "is-focused" : ""}`}>
        <ProfileAvatar name={profile.name} color={profile.color} avatar={profile.avatar} size={180} className={shape} />
      </div>
      <span className={`max-w-full truncate text-3xl ${design === "terminal" ? "t-label" : ""} ${focused ? "font-bold text-text" : "text-muted"}`}>
        {profile.has_pin ? "🔒 " : ""}
        {profile.name}
      </span>
    </div>
  );
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"];

function PinPad({ profile, onCancel, onOk }: { profile: Profile; onCancel: () => void; onOk: () => void }) {
  const { t } = useI18n();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void setFocus("pin-1");
  }, []);

  // Digits typed on the remote's number keys also work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) setPin((p) => (p + e.key).slice(0, 8));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = async () => {
    if (pin.length < 4) return;
    setBusy(true);
    try {
      await unwrap(api.POST("/profiles/{id}/verify-pin", { params: { path: { id: profile.id } }, body: { pin } }));
      onOk();
    } catch (e) {
      setPin("");
      setError(e instanceof ApiError && e.code === "rate_limited" ? t("common.rate_limited", { seconds: e.retryAfter ?? 60 }) : t("profiles.wrong_pin"));
    } finally {
      setBusy(false);
    }
  };

  const press = (k: string) => {
    setError("");
    if (k === "⌫") setPin((p) => p.slice(0, -1));
    else if (k === "OK") void submit();
    else setPin((p) => (p + k).slice(0, 8));
  };

  return (
    <div className="flex h-full flex-col items-center justify-center space-y-10">
      <ProfileAvatar name={profile.name} color={profile.color} avatar={profile.avatar} size={140} className="rounded-3xl" />
      <h1 className="text-5xl font-bold">{t("profiles.enter_pin", { name: profile.name })}</h1>
      <div className="flex h-16 space-x-4">
        {busy ? <Spinner size={48} /> : Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={`h-6 w-6 rounded-full ${i < pin.length ? "bg-accent" : "bg-surface-2"}`} />
        ))}
      </div>
      {error && <p className="text-3xl text-danger">{error}</p>}
      {/* 3×4 keypad with flex-wrap + margins (no CSS grid/gap on old TV engines). */}
      <FocusSection focusKey="pinpad" boundary className="flex flex-wrap" style={{ width: 3 * (128 + 20) }}>
        {KEYS.map((k) => (
          <div key={k} className="mb-5 mr-5">
            <FocusButton focusKey={`pin-${k}`} onPress={() => press(k)} className="flex h-24 w-32 items-center justify-center rounded-control bg-surface-2 text-4xl font-semibold">
              {k}
            </FocusButton>
          </div>
        ))}
      </FocusSection>
      <FocusButton focusKey="pin-cancel" onPress={onCancel} className="rounded-2xl px-8 py-3 text-2xl text-muted">
        {t("common.cancel")}
      </FocusButton>
    </div>
  );
}
