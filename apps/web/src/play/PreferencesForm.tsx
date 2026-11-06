import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { api } from "../api";
import { Button, Card, ErrorText, fieldErrors, Input } from "../components";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CloseIcon } from "../icons";
import { codecLabel, languageName, resolutionLabel } from "./releases";
import {
  addVoiceover,
  CODECS,
  MAX_VOICEOVERS,
  moveItem,
  VOICEOVER_SUGGESTIONS,
  formatMaxSize,
  languageOptions,
  parseMaxSize,
  prefsFieldErrors,
  RESOLUTIONS,
  toggleOrdered,
  type Preferences,
} from "./prefs";

const prefsKey = (id: string) => ["profile-prefs", id] as const;

/** Playback preferences of one profile (used to rank releases). */
export function PreferencesCard({ profileId, profileName }: { profileId: string; profileName: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: prefsKey(profileId),
    queryFn: () => unwrap(api.GET("/profiles/{id}/preferences", { params: { path: { id: profileId } } })),
  });
  return (
    <Card className="mt-4">
      <div data-testid="prefs-card">
        <h2 className="text-lg font-bold">{t("player.prefs.title")}</h2>
        <p className="mt-0.5 text-sm text-muted">{t("player.prefs.hint", { name: profileName })}</p>
        <div className="mt-4">
          {q.isPending ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : q.error ? (
            <ErrorText error={q.error} />
          ) : (
            <PrefsForm key={profileId} profileId={profileId} initial={q.data} />
          )}
        </div>
      </div>
    </Card>
  );
}

function PrefsForm({ profileId, initial }: { profileId: string; initial: Preferences }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [audio, setAudio] = useState(initial.preferred_audio_languages);
  const [subs, setSubs] = useState(initial.preferred_subtitle_languages);
  const [resolution, setResolution] = useState<Preferences["preferred_resolution"]>(initial.preferred_resolution);
  const [maxSize, setMaxSize] = useState(formatMaxSize(initial.max_size_gb));
  const [codecs, setCodecs] = useState(initial.preferred_codecs);
  const [voiceovers, setVoiceovers] = useState(initial.preferred_voiceovers ?? []);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: Preferences) =>
      unwrap(api.PUT("/profiles/{id}/preferences", { params: { path: { id: profileId } }, body })),
    onSuccess: (data) => {
      qc.setQueryData(prefsKey(profileId), data);
      // Rankings depend on preferences.
      qc.invalidateQueries({ queryKey: ["releases"] });
    },
  });
  const errs = prefsFieldErrors(fieldErrors(save.error));
  const hasFieldErrs = Object.keys(errs).length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const size = parseMaxSize(maxSize);
    if (size === "invalid") {
      setLocalErr(t("player.prefs.max_size_invalid"));
      return;
    }
    setLocalErr(null);
    save.mutate({
      ui_language: initial.ui_language,
      preferred_audio_languages: audio,
      preferred_subtitle_languages: subs,
      preferred_resolution: resolution,
      max_size_gb: size,
      preferred_codecs: codecs,
      preferred_voiceovers: voiceovers,
    });
  };
  const touched = () => save.isSuccess && save.reset();

  const langChips = (selected: string[], set: (v: string[]) => void, testId: string) => (
    <Chips
      testId={testId}
      options={languageOptions(selected).map((l) => ({ value: l, label: languageName(l, locale), short: l.toUpperCase() }))}
      selected={selected}
      onToggle={(v) => {
        set(toggleOrdered(selected, v));
        touched();
      }}
    />
  );

  return (
    <form onSubmit={submit} className="space-y-5" data-testid="prefs-form">
      <Group label={t("player.prefs.audio")} hint={t("player.prefs.order_hint")} error={errs.audio}>
        {langChips(audio, setAudio, "prefs-audio")}
      </Group>
      <Group label={t("player.prefs.subtitles")} error={errs.subtitles}>
        {langChips(subs, setSubs, "prefs-subtitles")}
      </Group>
      <Group label={t("player.prefs.resolution")} error={errs.resolution}>
        <div role="radiogroup" aria-label={t("player.prefs.resolution")} className="flex flex-wrap gap-2">
          {RESOLUTIONS.map((r) => {
            const on = r === resolution;
            return (
              <button
                key={r || "any"}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setResolution(r);
                  touched();
                }}
                className={`min-h-[40px] rounded-xl border px-3.5 text-sm font-semibold transition ${
                  on ? "border-accent bg-accent text-on-accent" : "border-border bg-bg text-text/85 hover:border-muted"
                }`}
              >
                {r ? resolutionLabel(r) : t("player.prefs.any")}
              </button>
            );
          })}
        </div>
      </Group>
      <Group label={t("player.prefs.max_size")} hint={t("player.prefs.max_size_hint")} error={localErr ?? errs.max_size} htmlFor="prefs-max-size">
        <div className="flex max-w-[12rem] items-center gap-2">
          <Input
            id="prefs-max-size"
            inputMode="decimal"
            value={maxSize}
            placeholder={t("player.prefs.no_limit")}
            aria-invalid={!!(localErr ?? errs.max_size)}
            onChange={(e) => {
              setMaxSize(e.target.value);
              setLocalErr(null);
              touched();
            }}
          />
          <span className="text-sm font-semibold text-muted">GB</span>
        </div>
      </Group>
      <Group label={t("player.prefs.codecs")} hint={t("player.prefs.order_hint")} error={errs.codecs}>
        <Chips
          testId="prefs-codecs"
          options={CODECS.map((c) => ({ value: c, label: codecLabel(c) ?? c }))}
          selected={codecs}
          onToggle={(v) => {
            setCodecs(toggleOrdered(codecs, v));
            touched();
          }}
        />
      </Group>
      <Group label={t("player.prefs.voiceovers")} hint={t("player.prefs.order_hint")} error={errs.voiceovers}>
        <p className="-mt-1 text-xs text-muted">{t("player.prefs.voiceovers_hint")}</p>
        <VoiceoverEditor
          value={voiceovers}
          onChange={(v) => {
            setVoiceovers(v);
            touched();
          }}
        />
      </Group>
      {errs.other && <p className="text-sm text-danger">{errs.other}</p>}
      <ErrorText error={hasFieldErrs ? null : save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" busy={save.isPending} data-testid="prefs-save">
          {t("common.save")}
        </Button>
        {save.isSuccess && (
          <span className="flex items-center gap-1.5 text-sm font-semibold text-ok" role="status">
            <CheckIcon />
            {t("player.prefs.saved")}
          </span>
        )}
      </div>
    </form>
  );
}

/** Ordered list of preferred dub/voice-over studios: add (free text or suggestion), remove, reorder. */
export function VoiceoverEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const full = value.length >= MAX_VOICEOVERS;
  const add = (name: string) => {
    onChange(addVoiceover(value, name));
    setText("");
  };
  const suggestions = VOICEOVER_SUGGESTIONS.filter((s) => !value.some((v) => v.toLocaleLowerCase() === s.toLocaleLowerCase()));
  const btn = "flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-30";
  return (
    <div className="space-y-2.5" data-testid="prefs-voiceovers">
      {value.length > 0 && (
        <ol className="space-y-1.5">
          {value.map((v, i) => (
            <li key={v} className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 py-1 pl-2 pr-1 text-sm font-semibold">
              <span className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-md bg-accent px-1 text-[11px] font-bold text-on-accent">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{v}</span>
              <button type="button" className={btn} disabled={i === 0} aria-label={t("player.prefs.move_up", { name: v })} onClick={() => onChange(moveItem(value, i, -1))}>
                <ArrowUpIcon />
              </button>
              <button
                type="button"
                className={btn}
                disabled={i === value.length - 1}
                aria-label={t("player.prefs.move_down", { name: v })}
                onClick={() => onChange(moveItem(value, i, 1))}
              >
                <ArrowDownIcon />
              </button>
              <button type="button" className={btn} aria-label={t("player.prefs.remove", { name: v })} onClick={() => onChange(value.filter((x) => x !== v))}>
                <CloseIcon />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex max-w-md gap-2">
        <Input
          value={text}
          maxLength={40}
          disabled={full}
          list="voiceover-suggestions"
          placeholder={t("player.prefs.voiceover_placeholder")}
          aria-label={t("player.prefs.voiceover_placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(text);
            }
          }}
        />
        <Button type="button" variant="secondary" disabled={full || !text.trim()} onClick={() => add(text)}>
          {t("player.prefs.add")}
        </Button>
        <datalist id="voiceover-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      {!full && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="min-h-[34px] rounded-full border border-dashed border-border px-3 text-xs font-semibold text-text/80 transition hover:border-accent hover:text-text"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Group({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-semibold">
            {label}
          </label>
        ) : (
          <span className="text-sm font-semibold">{label}</span>
        )}
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </div>
      {children}
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Multi-select chips; selected ones show their priority number. */
export function Chips({
  options,
  selected,
  onToggle,
  testId,
}: {
  options: { value: string; label: string; short?: string }[];
  selected: string[];
  onToggle: (v: string) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {options.map((o) => {
        const rank = selected.indexOf(o.value);
        const on = rank >= 0;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(o.value)}
            className={`flex min-h-[40px] items-center gap-2 rounded-xl border pr-3 ${on || o.short ? "pl-2" : "pl-3"} text-sm font-semibold transition ${
              on ? "border-accent bg-accent/15 text-text" : "border-border bg-bg text-text/80 hover:border-muted"
            }`}
          >
            {(on || o.short) && (
            <span
              className={`flex h-6 min-w-[1.5rem] items-center justify-center rounded-md px-1 text-[11px] font-bold ${
                on ? "bg-accent text-on-accent" : "bg-surface-2 text-muted"
              }`}
            >
              {on ? rank + 1 : o.short}
            </span>
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
