import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, unwrap, type Profile } from "@martytv/contracts";
import { Centered, ProfileAvatar, Spinner, useI18n } from "@martytv/ui";
import { api } from "../api";
import { useProfiles } from "../queries";
import { useSession } from "../session";
import { Button, ErrorText, Input } from "../components";
import { Sheet } from "../remote/SendToTv";
import { needsPin, readStoredProfile, resolveActiveProfile, storeProfile } from "./profile";

interface ActiveProfileCtx {
  profiles: Profile[];
  /** The profile this browser is browsing as (null: the account has none). */
  profile: Profile | null;
  profileId: string | undefined;
  /** Switch profiles; asks for the PIN when needed. */
  switchTo: (p: Profile) => void;
}

const Ctx = createContext<ActiveProfileCtx | null>(null);

export function useActiveProfile(): ActiveProfileCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActiveProfile must be used inside ActiveProfileProvider");
  return v;
}

/**
 * Resolves the active profile once the profile list is known, so every
 * catalog/watch request carries the right profile_id from the start.
 */
export function ActiveProfileProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user.id ?? "";
  const profilesQ = useProfiles();
  const [stored, setStored] = useState<string | null>(() => (userId ? readStoredProfile(userId) : null));
  const [pinFor, setPinFor] = useState<Profile | null>(null);

  const profiles = useMemo(() => profilesQ.data ?? [], [profilesQ.data]);
  const activeId = resolveActiveProfile(profiles, stored);
  const profile = profiles.find((p) => p.id === activeId) ?? null;

  const activate = useCallback(
    (id: string) => {
      setStored(id);
      if (userId) storeProfile(userId, id);
    },
    [userId],
  );
  const switchTo = useCallback(
    (p: Profile) => {
      if (needsPin(p, activeId)) setPinFor(p);
      else activate(p.id);
    },
    [activeId, activate],
  );
  const value = useMemo<ActiveProfileCtx>(
    () => ({ profiles, profile, profileId: profile?.id, switchTo }),
    [profiles, profile, switchTo],
  );

  // Wait for the list (errors fall through: browse without a profile).
  if (profilesQ.isPending) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }
  return (
    <Ctx.Provider value={value}>
      {children}
      {pinFor && (
        <PinSheet
          profile={pinFor}
          onClose={() => setPinFor(null)}
          onOk={() => {
            activate(pinFor.id);
            setPinFor(null);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

function PinSheet({ profile, onClose, onOk }: { profile: Profile; onClose: () => void; onOk: () => void }) {
  const { t } = useI18n();
  const [pin, setPin] = useState("");
  const [wrong, setWrong] = useState(false);
  const verify = useMutation({
    mutationFn: () => unwrap(api.POST("/profiles/{id}/verify-pin", { params: { path: { id: profile.id } }, body: { pin } })),
    onSuccess: (r) => (r.ok ? onOk() : setWrong(true)),
    onError: (e) => setWrong(e instanceof ApiError && e.status === 403),
  });
  return (
    <Sheet title={t("profiles.enter_pin", { name: profile.name })} onClose={onClose} testId="pin-sheet">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setWrong(false);
          verify.mutate();
        }}
      >
        <div className="flex justify-center">
          <ProfileAvatar name={profile.name} color={profile.color} avatar={profile.avatar} size={64} />
        </div>
        <Input
          data-autofocus
          aria-label={t("profiles.enter_pin", { name: profile.name })}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          inputMode="numeric"
          autoComplete="off"
          type="password"
          className="text-center text-2xl tracking-[0.5em]"
        />
        {wrong ? (
          <p role="alert" className="text-center text-sm text-danger">
            {t("profiles.wrong_pin")}
          </p>
        ) : (
          <ErrorText error={verify.error} />
        )}
        <Button type="submit" className="w-full" busy={verify.isPending} disabled={pin.length < 4}>
          {t("profile.switch_confirm")}
        </Button>
      </form>
    </Sheet>
  );
}
