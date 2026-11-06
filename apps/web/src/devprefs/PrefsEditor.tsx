// Playback profile editor shared by Settings → «Это устройство» (this
// browser), the Devices page sheet and Admin → Устройства (a TV): detected
// summary, one-tap presets, manual rows, «Сбросить на авто».
import { useEffect, useState } from "react";
import { applyPreset, constraints, constraintText, effectivePrefs, PRESETS, type PlaybackAuto, type PlaybackManual } from "@martytv/media-types";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Button, ErrorText, Select } from "../components";
import { CheckIcon } from "../icons";
import { decodeOpt, detectedSummary, looseT, encodeOpt, optionLabel, rowOptions, rowsFor, rowValue, setRow } from "./logic";

export interface PrefsEditorProps {
  auto: PlaybackAuto | null | undefined;
  manual: PlaybackManual | null | undefined;
  kind: "tv" | "browser";
  onSave: (m: PlaybackManual) => void;
  busy?: boolean;
  error?: unknown;
  /** Bumped after each successful save («Сохранено»). */
  savedAt?: number;
  testId?: string;
}

export function PrefsEditor({ auto, manual: savedManual, kind, onSave, busy, error, savedAt, testId }: PrefsEditorProps) {
  const { t } = useI18n();
  // Local copy: rows react at once; the server answer replaces it.
  const [manual, setManual] = useState<PlaybackManual>(savedManual ?? {});
  const [base, setBase] = useState(savedManual);
  if (base !== savedManual) {
    setBase(savedManual);
    setManual(savedManual ?? {});
  }
  const save = (m: PlaybackManual) => {
    setManual(m);
    onSave(m);
  };
  const detected = detectedSummary(auto, t);
  const applied = constraints(effectivePrefs({ auto: auto ?? {}, manual })).map((c) => constraintText(c, looseT(t)));
  const [hiddenFor, setHiddenFor] = useState(0);
  const shownSaved = !!savedAt && savedAt !== hiddenFor;
  useEffect(() => {
    if (!savedAt) return;
    const id = setTimeout(() => setHiddenFor(savedAt), 2000);
    return () => clearTimeout(id);
  }, [savedAt]);

  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="rounded-xl bg-surface-2/60 px-3 py-2.5 text-sm" data-testid="prefs-detected">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{t("tvplay.device.detected")}</p>
        {detected.length ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {detected.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted">{d.label}</dt>
                <dd className="min-w-0 break-words">{d.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted">{t("tvplay.device.detected_none")}</p>
        )}
        {applied.length > 0 && (
          <p className="mt-1.5 text-xs text-accent" data-testid="prefs-applied">
            {t("tvplay.picked_for", { list: applied.join(", ") })}
          </p>
        )}
      </div>

      <div>
        <p className="mb-2 text-sm text-muted">{t("tvplay.device.presets")}</p>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("tvplay.device.presets")}>
          {PRESETS.map((p) => {
            const on = manual.preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                data-preset={p.id}
                disabled={busy}
                onClick={() => save(applyPreset(manual, p.id))}
                className={`rounded-xl border px-3 py-2 text-left transition disabled:opacity-60 ${on ? "border-accent bg-accent/10 ring-1 ring-accent" : "border-border hover:border-muted"}`}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {on && <CheckIcon className="text-accent" />}
                  {t(`tvplay.preset.${p.id}` as MessageKey)}
                </span>
                <span className="block text-xs text-muted">{t(`tvplay.preset.${p.id}_desc` as MessageKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="divide-y divide-border rounded-xl border border-border">
        {rowsFor(kind).map((row) => (
          <label key={row.key} className="flex items-center gap-3 px-3.5 py-2">
            <span className="min-w-0 flex-1 font-medium">{t(row.label)}</span>
            <Select
              className="!min-h-[40px] w-auto max-w-[55%] py-1"
              value={encodeOpt(rowValue(manual, row.key))}
              data-testid={`prefs-row-${row.key}`}
              onChange={(e) => save(setRow(manual, row.key, decodeOpt(row, e.target.value)))}
            >
              {rowOptions(row, manual).map((o) => (
                <option key={encodeOpt(o)} value={encodeOpt(o)}>
                  {optionLabel(row.key, o, t, auto ?? undefined)}
                </option>
              ))}
            </Select>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-3 px-3.5 py-3">
          <span className="min-w-0 flex-1 font-medium">{t("tvplay.row.prefer_smaller")}</span>
          <button
            type="button"
            role="switch"
            aria-checked={!!manual.prefer_smaller}
            aria-label={t("tvplay.row.prefer_smaller")}
            data-testid="prefs-row-prefer_smaller"
            onClick={() => save({ ...manual, prefer_smaller: manual.prefer_smaller ? null : true })}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${manual.prefer_smaller ? "bg-accent" : "bg-text/20"}`}
          >
            <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left] ${manual.prefer_smaller ? "left-[1.375rem]" : "left-0.5"}`} />
          </button>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => save({})} disabled={busy} data-testid="prefs-reset">
          {t("tvplay.device.reset")}
        </Button>
        {busy && <Spinner size={18} />}
        <span
          aria-live="polite"
          data-testid="prefs-saved"
          className={`flex items-center gap-1 text-sm font-semibold text-ok transition-opacity ${shownSaved ? "opacity-100" : "opacity-0"}`}
        >
          {shownSaved ? (
            <>
              <CheckIcon /> {t("tvplay.device.saved")}
            </>
          ) : null}
        </span>
      </div>
      <ErrorText error={error} />
    </div>
  );
}
