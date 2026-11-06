import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Profile } from "@martytv/contracts";
import { PROFILE_COLORS, ProfileAvatar, useI18n } from "@martytv/ui";
import { api } from "../api";
import { useProfiles } from "../queries";
import { Button, Card, ErrorText, Field, fieldErrors, Input, PageTitle } from "../components";
import { PreferencesCard } from "../play/PreferencesForm";

export const AVATARS = ["", "🎬", "🍿", "🦊", "🐼", "🚀", "🌙", "⚽", "🎮", "🐱"];

export function ProfilesPage() {
  const { t } = useI18n();
  const { data: profiles, error } = useProfiles();
  const [editing, setEditing] = useState<Profile | "new" | null>(null);

  return (
    <div>
      <PageTitle
        action={
          editing === null && (profiles?.length ?? 0) < 8 ? (
            <Button onClick={() => setEditing("new")}>{t("profiles.add")}</Button>
          ) : null
        }
      >
        {t("nav.profiles")}
      </PageTitle>
      <ErrorText error={error} />
      {editing && (
        <ProfileForm key={editing === "new" ? "new" : editing.id} profile={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />
      )}
      {editing && editing !== "new" && <PreferencesCard key={editing.id} profileId={editing.id} profileName={editing.name} />}
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {profiles?.map((p) => (
          <button
            key={p.id}
            onClick={() => setEditing(p)}
            className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface p-4 hover:border-accent"
          >
            <ProfileAvatar name={p.name} color={p.color} avatar={p.avatar} size={72} />
            <span className="max-w-full truncate font-medium">{p.name}</span>
            {p.has_pin && <span className="text-xs text-muted">🔒 {t("profiles.locked")}</span>}
          </button>
        ))}
      </div>
      {profiles?.length === 0 && !editing && <p className="text-muted">{t("profiles.empty")}</p>}
    </div>
  );
}

function ProfileForm({ profile, onDone }: { profile?: Profile; onDone: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState(profile?.name ?? "");
  const [color, setColor] = useState(profile?.color ?? PROFILE_COLORS[0]!);
  const [avatar, setAvatar] = useState(profile?.avatar ?? "");
  const [pin, setPin] = useState("");
  const [clearPin, setClearPin] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, color, avatar, ...(pin ? { pin } : {}), ...(clearPin ? { clear_pin: true } : {}) };
      return profile
        ? unwrap(api.PATCH("/profiles/{id}", { params: { path: { id: profile.id } }, body }))
        : unwrap(api.POST("/profiles", { body }));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/profiles/{id}", { params: { path: { id: profile!.id } } })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      onDone();
    },
  });
  const errs = fieldErrors(save.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center gap-4">
          <ProfileAvatar name={name || "?"} color={color} avatar={avatar} size={64} />
          <Field label={t("profiles.name")} error={errs.name}>
            <Input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
        </div>
        <div>
          <span className="text-sm text-muted">{t("profiles.color")}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {PROFILE_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                aria-label={c}
                onClick={() => setColor(c)}
                className={`h-9 w-9 rounded-full ${c === color ? "ring-2 ring-text ring-offset-2 ring-offset-surface" : ""}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        <div>
          <span className="text-sm text-muted">{t("profiles.avatar")}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {AVATARS.map((a) => (
              <button
                type="button"
                key={a || "initial"}
                onClick={() => setAvatar(a)}
                className={`flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-xl ${a === avatar ? "ring-2 ring-accent" : ""}`}
              >
                {a || (name.trim()[0] ?? "A").toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <Field label={t("profiles.pin")} error={errs.pin}>
          <Input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            autoComplete="off"
            placeholder={profile?.has_pin ? "••••" : ""}
          />
        </Field>
        {profile?.has_pin && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={clearPin} onChange={(e) => setClearPin(e.target.checked)} />
            {t("profiles.remove_pin")}
          </label>
        )}
        <ErrorText error={Object.keys(errs).length ? null : (save.error ?? remove.error)} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={save.isPending}>
            {t("common.save")}
          </Button>
          <Button type="button" variant="secondary" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          {profile && (
            <Button
              type="button"
              variant="danger"
              className="ml-auto"
              busy={remove.isPending}
              onClick={() => {
                if (confirm(t("profiles.delete_confirm", { name: profile.name }))) remove.mutate();
              }}
            >
              {t("common.delete")}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
