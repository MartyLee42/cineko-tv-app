// Playback profile screens: Settings → «Это устройство» (this browser), the
// per-TV «Настройки воспроизведения» sheet (Devices page, Admin → Устройства),
// the user's browsers list, and the app-level agent that reports this
// browser's capabilities and offers a preset on weak devices.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { applyPreset, constraintText, runResultText, suggestPreset, type Constraint } from "@martytv/media-types";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Button, Card, ErrorText, timeAgo } from "../components";
import { CloseIcon, DeviceIcon } from "../icons";
import { Sheet } from "../remote/SendToTv";
import { useSession } from "../session";
import { clientId, detectedSummary, dismissSuggest, isAllAuto, looseT, suggestDismissed, toAuto } from "./logic";
import { PrefsEditor } from "./PrefsEditor";
import { slowHintPref } from "../player/slowHint";
import { speedtest, speedtestLine, useSpeedtest } from "./speedtest";
import {
  detectHere,
  syncClient,
  useClientPrefs,
  useDevicePrefs,
  useForgetClient,
  usePlaybackClients,
  useSaveClientManual,
  useSaveDeviceManual,
} from "./queries";

/** Settings → «Это устройство»: this browser's playback profile. */
export function ThisDeviceCard() {
  const { t } = useI18n();
  const q = useClientPrefs();
  const save = useSaveClientManual();
  // Before the first report the summary shows what this browser detects now.
  const [local] = useState(detectHere);
  return (
    <Card className="space-y-4">
      <div id="this-device" className="scroll-mt-20">
        <h2 className="text-lg font-bold">{t("tvplay.device.title")}</h2>
        <p className="text-xs text-muted">{t("devprefs.this_browser_hint")}</p>
      </div>
      {q.isPending ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : (
        <>
          <ErrorText error={q.error} />
          <SuggestPreset />
          <PrefsEditor
            testId="this-device-prefs"
            kind="browser"
            auto={toAuto(q.data?.auto ?? local)}
            manual={q.data?.manual}
            onSave={(m) => save.mutate(m)}
            busy={save.isPending}
            error={save.error}
            savedAt={save.isSuccess ? save.submittedAt : 0}
          />
          <SlowHintSwitch />
          <SpeedtestRow />
        </>
      )}
    </Card>
  );
}

/** «Предупреждать о медленной скорости» for this browser (off by default). */
function SlowHintSwitch() {
  const { t } = useI18n();
  const [on, setOn] = useState(slowHintPref.get);
  return (
    <div className="flex items-center gap-3 border-t border-border pt-4">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{t("tvplay.row.slow_hint")}</span>
        <span className="block text-xs text-muted">{t("tvplay.row.slow_hint_hint")}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t("tvplay.row.slow_hint")}
        data-testid="slow-hint-switch"
        onClick={() => {
          slowHintPref.set(!on);
          setOn(!on);
        }}
        className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? "bg-accent" : "bg-text/20"}`}
      >
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left] ${on ? "left-[1.375rem]" : "left-0.5"}`} />
      </button>
    </div>
  );
}

/**
 * «Измерять скорость интернета в фоне» (this browser; on by default), the
 * last result and «Проверить сейчас» (allowed with the switch off, never
 * while something plays).
 */
function SpeedtestRow() {
  const { t } = useI18n();
  useSpeedtest();
  const [result, setResult] = useState<string | null>(null);
  const on = speedtest.enabled();
  const running = speedtest.running();
  const paused = on ? speedtest.paused() : null;
  const lt = looseT(t);
  const check = () => {
    setResult(null);
    void speedtest.runNow().then((r) => setResult(runResultText(r, lt)));
  };
  return (
    <div className="divide-y divide-border rounded-xl bg-surface-2" data-testid="speedtest-row">
      <label className="flex cursor-pointer items-center gap-4 px-3.5 py-3">
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{t("tvplay.net.row")}</span>
          <span className="mt-0.5 block text-xs text-muted">{t("tvplay.net.row_hint")}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t("tvplay.net.row")}
          data-testid="speedtest-toggle"
          onClick={() => speedtest.setEnabled(!on)}
          className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? "bg-accent" : "bg-text/20"}`}
        >
          <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left] ${on ? "left-[1.375rem]" : "left-0.5"}`} />
        </button>
      </label>
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <div className="min-w-0 flex-1 text-sm">
          <p data-testid="speedtest-last">{speedtestLine(lt)}</p>
          {paused && <p className="text-xs text-muted">{t(`tvplay.net.${paused}`)}</p>}
          {result && !running && (
            <p className="text-xs text-muted" role="status" data-testid="speedtest-result">
              {result}
            </p>
          )}
        </div>
        <Button variant="secondary" className="min-h-[40px]" disabled={running} onClick={check} data-testid="speedtest-run">
          {running && <Spinner />}
          {t("tvplay.net.check")}
        </Button>
      </div>
    </div>
  );
}

/** «Настройки воспроизведения» of a TV (owner / `use` / super-admin). */
export function DevicePrefsSheet({ deviceId, name, onClose }: { deviceId: string; name: string; onClose: () => void }) {
  const { t } = useI18n();
  const q = useDevicePrefs(deviceId);
  const save = useSaveDeviceManual(deviceId);
  return (
    <Sheet title={t("devprefs.sheet_title")} subtitle={t("devprefs.sheet_subtitle", { name })} onClose={onClose} testId="device-prefs-sheet">
      {q.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : q.error ? (
        <ErrorText error={q.error} />
      ) : (
        <PrefsEditor
          kind="tv"
          auto={toAuto(q.data?.auto)}
          manual={q.data?.manual}
          onSave={(m) => save.mutate(m)}
          busy={save.isPending}
          error={save.error}
          savedAt={save.isSuccess ? save.submittedAt : 0}
        />
      )}
    </Sheet>
  );
}

/** Button + sheet, for device cards and admin rows. */
export function DevicePrefsButton({ deviceId, name, className = "" }: { deviceId: string; name: string; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" className={className} onClick={() => setOpen(true)} data-testid="device-prefs-open">
        {t("devprefs.open")}
      </Button>
      {open && <DevicePrefsSheet deviceId={deviceId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Devices page: the user's browsers with a playback profile (hidden when none / unavailable). */
export function PlaybackClientsCard() {
  const { t, locale } = useI18n();
  const q = usePlaybackClients();
  const forget = useForgetClient();
  const me = clientId();
  const items = q.data ?? [];
  if (!items.length) return null;
  return (
    <Card className="space-y-3">
      <div data-testid="playback-clients">
        <h2 className="text-lg font-semibold">{t("devprefs.browsers")}</h2>
        <p className="text-xs text-muted">{t("devprefs.browsers_hint")}</p>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {items.map((c) => {
          const summary = c.constraints.length ? c.constraints.map((x) => constraintText(x as Constraint, looseT(t))).join(", ") : t("devprefs.auto_only");
          return (
            <li key={c.client_id} className="flex items-center gap-3 px-3 py-2.5 text-sm" data-testid="playback-client">
              <DeviceIcon className="shrink-0 text-lg text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {c.name || c.auto.model || c.platform || c.client_id}
                  {c.client_id === me && <span className="ml-1.5 text-xs font-normal text-accent">· {t("devprefs.this_one")}</span>}
                </p>
                <p className="truncate text-xs text-muted">
                  {[summary, c.updated_at ? timeAgo(c.updated_at, locale) : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              {c.client_id !== me && (
                <button
                  type="button"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:text-danger"
                  aria-label={t("devprefs.forget")}
                  title={t("devprefs.forget")}
                  disabled={forget.isPending}
                  onClick={() => forget.mutate(c.client_id)}
                >
                  <CloseIcon />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Mounted once in the signed-in layout: reports this browser's capabilities
 * (throttled) and, on a weak device with nothing set yet, offers a preset.
 */
export function ClientPrefsAgent() {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const userId = session?.user.id;
  useEffect(() => {
    if (userId) void syncClient(qc, userId);
  }, [qc, userId]);
  // Background speed test while signed in (first one ~25 s after start).
  useEffect(() => {
    if (!userId) return;
    speedtest.start();
    return () => speedtest.stop();
  }, [userId]);
  return null;
}

/**
 * First-run suggestion inside «Это устройство» (inline, never an overlay that
 * could cover the page): a weak-looking device with nothing set yet.
 */
function SuggestPreset() {
  const { t } = useI18n();
  const prefs = useClientPrefs();
  const save = useSaveClientManual();
  const [dismissed, setDismissed] = useState(suggestDismissed);
  const p = prefs.data;
  const auto = toAuto(p?.auto) ?? {};
  const preset = !dismissed && p && isAllAuto(p.manual) ? suggestPreset({ auto, manual: p.manual }) : null;
  if (!p || !preset) return null;
  const close = () => {
    dismissSuggest();
    setDismissed(true);
  };
  return (
    <div
      role="status"
      data-testid="devprefs-suggest"
      className="rounded-2xl border border-accent/40 bg-surface-2 px-4 py-3"
    >
      <p className="font-semibold">{t("devprefs.suggest_title")}</p>
      <p className="mt-0.5 text-sm text-muted">
        {t(`tvplay.preset.${preset}` as MessageKey)} — {t(`tvplay.preset.${preset}_desc` as MessageKey)}
      </p>
      <p className="mt-0.5 text-xs text-muted">{detectedSummary(auto, t).map((d) => d.value).slice(0, 3).join(" · ")}</p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" className="min-h-[40px]" onClick={close} data-testid="devprefs-suggest-later">
          {t("tvplay.device.suggest_later")}
        </Button>
        <Button
          className="min-h-[40px]"
          busy={save.isPending}
          data-testid="devprefs-suggest-apply"
          onClick={() => save.mutate(applyPreset(p.manual ?? {}, preset), { onSuccess: close })}
        >
          {t("tvplay.device.suggest_apply")}
        </Button>
      </div>
      <ErrorText error={save.error} />
    </div>
  );
}
