// Settings → «Это устройство»: this TV's playback profile. What the TV
// detected (summary), the manual overrides (choice rows), one-tap presets and
// «Сбросить на авто». Saved to the server (PATCH /devices/me/playback-prefs);
// the phone edits the same profile from Devices → the TV.
import { useEffect, useState } from "react";
import { applyPreset, effectivePrefs, landscapeSize, PRESETS, runResultText, suggestPreset, type PlaybackPrefsLike } from "@martytv/media-types";
import { useI18n, type MessageKey } from "@martytv/ui";
import { storage } from "../platform";
import { mbit, prebufferPref, slowHintPref } from "../player/rebuffer";
import { devicePrefs, useDevicePrefs, type PlaybackAuto, type PlaybackManual } from "./devicePrefs";
import type { Choice, Row } from "./OptionList";
import { speedtest, speedtestLine, useSpeedtest } from "./speedtest";

const VIDEO_LABEL: Record<string, string> = { h264: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1", hdr10: "HDR10", dv: "Dolby Vision" };
const AUDIO_LABEL: Record<string, string> = { aac: "AAC", ac3: "AC3", eac3: "E-AC3", dts: "DTS", truehd: "TrueHD", mp3: "MP3", opus: "Opus", flac: "FLAC" };
const SUGGEST_KEY = "martytv.device_prefs_suggest_dismissed";

/** «TX3 · Android 11 · MSX · Видео H.264, HEVC · Звук AAC · ≈14.2 Мбит/с · 3840×2160». */
export function detectedSummary(a: PlaybackAuto | null | undefined, t: (k: MessageKey, v?: Record<string, string | number>) => string): string | null {
  if (!a || (!a.video?.length && !a.model && !a.throughput_bps)) return null;
  const parts = [
    a.model || null,
    a.video?.length ? `${t("tvplay.device.video")} ${a.video.map((v) => VIDEO_LABEL[v] ?? v).join(", ")}` : null,
    a.audio?.length ? `${t("tvplay.device.audio")} ${a.audio.map((v) => AUDIO_LABEL[v] ?? v).join(", ")}` : null,
    a.compat ? t("tvplay.device.compat_yes") : null,
    a.throughput_bps ? `${t("tvplay.device.throughput")} ≈${mbit(a.throughput_bps)} Mbit/s` : null,
    a.screen_width && a.screen_height ? `${t("tvplay.device.screen")} ${landscapeSize(a.screen_width, a.screen_height).width}×${landscapeSize(a.screen_width, a.screen_height).height}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Rows of the «Это устройство» section (empty until the profile is known). */
export function useDevicePlaybackRows(): { rows: Row[]; note: string | null } {
  const { t } = useI18n();
  const prefs = useDevicePrefs();
  const [note, setNote] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => storage.get(SUGGEST_KEY) === "1");
  const [slowHint, setSlowHint] = useState(() => slowHintPref.get());
  const [prebuffer, setPrebuffer] = useState(() => prebufferPref.get());
  useSpeedtest();
  useEffect(() => {
    void devicePrefs.sync();
  }, []);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3000);
    return () => clearTimeout(id);
  }, [note]);

  const manual: PlaybackManual = prefs?.manual ?? {};
  const autoEff = effectivePrefs(prefs ? ({ auto: prefs.auto, manual: {} } as PlaybackPrefsLike) : null);
  const save = (next: PlaybackManual, ok: string = t("tvplay.device.saved")) => {
    devicePrefs.saveManual(next).then(
      () => setNote(ok),
      () => setNote(t("tvplay.device.save_failed")),
    );
  };
  const set = (patch: Partial<PlaybackManual>) => save({ ...manual, ...patch, preset: null });
  const auto = (value: string | null) => (value ? t("tvplay.auto_value", { value }) : t("tvplay.auto"));
  const choice = (key: keyof PlaybackManual, label: MessageKey, choices: Choice<unknown>[], value: unknown): Row => ({
    kind: "choice",
    key: `dp-${key}`,
    label: t(label),
    hint: t("tvplay.device.hint"),
    choices,
    value,
    onChange: (v) => set({ [key]: v } as Partial<PlaybackManual>),
  });

  const header: Row = { kind: "header", key: "h-playback", label: t("tvplay.device.title"), hint: t("tvplay.device.hint") };
  const summary = detectedSummary(prefs?.auto, t);
  const rows: Row[] = [header, { kind: "note", key: "dp-detected", label: `${t("tvplay.device.detected")}: ${summary ?? t("tvplay.device.detected_none")}` }];
  if (!prefs) return { rows, note };

  const suggestion = dismissed ? null : suggestPreset(prefs as PlaybackPrefsLike);
  if (suggestion) {
    rows.push({ kind: "note", key: "dp-suggest", label: t("tvplay.device.suggest", { preset: t(`tvplay.preset.${suggestion}` as MessageKey) }) });
    rows.push({
      kind: "actions",
      key: "dp-suggest-actions",
      actions: [
        { key: "apply", primary: true, label: t("tvplay.device.suggest_apply"), onPress: () => save(applyPreset(manual, suggestion), t("tvplay.device.preset_applied")) },
        {
          key: "later",
          label: t("tvplay.device.suggest_later"),
          onPress: () => {
            storage.set(SUGGEST_KEY, "1");
            setDismissed(true);
          },
        },
      ],
    });
  }

  const resAuto = autoEff.max_resolution === "2160p" ? "4K" : autoEff.max_resolution;
  rows.push(
    choice(
      "max_resolution",
      "tvplay.row.max_resolution",
      [
        { value: null, label: auto(resAuto) },
        { value: "720p", label: "720p" },
        { value: "1080p", label: "1080p" },
        { value: "2160p", label: "4K" },
      ],
      manual.max_resolution ?? null,
    ),
    choice(
      "max_bitrate_mbps",
      "tvplay.row.max_bitrate",
      [
        { value: null, label: auto(autoEff.max_bitrate_bps ? t("tvplay.mbps", { n: Math.round(autoEff.max_bitrate_bps / 1e6) }) : null) },
        ...[8, 15, 25, 40].map((n) => ({ value: n, label: t("tvplay.mbps", { n }) })),
        { value: 0, label: t("tvplay.unlimited") },
      ],
      manual.max_bitrate_mbps ?? null,
    ),
    choice(
      "max_size_gb",
      "tvplay.row.max_size",
      [{ value: null, label: t("tvplay.unlimited") }, ...[2, 4, 8, 15, 30, 60].map((n) => ({ value: n, label: t("tvplay.gb", { n }) }))],
      manual.max_size_gb ?? null,
    ),
    choice(
      "video_codec",
      "tvplay.row.video_codec",
      [
        { value: null, label: t("tvplay.auto") },
        { value: "h264", label: "H.264" },
        { value: "hevc", label: "HEVC" },
      ],
      manual.video_codec ?? null,
    ),
    choice(
      "hdr",
      "tvplay.row.hdr",
      [
        { value: null, label: auto(autoEff.avoid_hdr ? t("tvplay.hdr.avoid") : t("tvplay.hdr.allow")) },
        { value: "allow", label: t("tvplay.hdr.allow") },
        { value: "avoid", label: t("tvplay.hdr.avoid") },
      ],
      manual.hdr ?? null,
    ),
    choice(
      "audio",
      "tvplay.row.audio",
      [
        { value: null, label: t("tvplay.auto") },
        { value: "prefer_aac_ac3", label: t("tvplay.audio.prefer_aac_ac3") },
        { value: "avoid_dts_truehd", label: t("tvplay.audio.avoid_dts_truehd") },
        { value: "always_compat", label: t("tvplay.audio.always_compat") },
      ],
      manual.audio ?? null,
    ),
    choice(
      "prefer_smaller",
      "tvplay.row.prefer_smaller",
      [
        { value: false, label: t("tvplay.off") },
        { value: true, label: t("tvplay.on") },
      ],
      !!manual.prefer_smaller,
    ),
    {
      // This TV only (not part of the synced profile); off by default.
      kind: "choice",
      key: "dp-slow-hint",
      label: t("tvplay.row.slow_hint"),
      hint: t("tvplay.row.slow_hint_hint"),
      choices: [
        { value: true, label: t("tvplay.on") },
        { value: false, label: t("tvplay.off") },
      ],
      value: slowHint,
      onChange: (v: unknown) => {
        slowHintPref.set(v === true);
        setSlowHint(v === true);
      },
    } as Row,
    {
      // This TV only; off by default.
      kind: "choice",
      key: "dp-prebuffer",
      label: t("pstats.row.prebuffer"),
      hint: t("pstats.row.prebuffer_hint"),
      choices: [
        { value: true, label: t("tvplay.on") },
        { value: false, label: t("tvplay.off") },
      ],
      value: prebuffer,
      onChange: (v: unknown) => {
        prebufferPref.set(v === true);
        setPrebuffer(v === true);
      },
    } as Row,
    {
      // This TV only: background speed test (on by default).
      kind: "choice",
      key: "dp-speedtest",
      label: t("tvplay.net.row"),
      hint: t("tvplay.net.row_hint"),
      choices: [
        { value: true, label: t("tvplay.on") },
        { value: false, label: t("tvplay.off") },
      ],
      value: speedtest.enabled(),
      onChange: (v: unknown) => speedtest.setEnabled(v === true),
    } as Row,
    { kind: "note", key: "dp-speedtest-last", label: speedtestLine((k, v) => t(k as MessageKey, v)) },
    {
      kind: "actions",
      key: "dp-speedtest-run",
      actions: [
        {
          key: "check",
          label: t("tvplay.net.check"),
          onPress: () => {
            if (speedtest.running()) return;
            void speedtest.runNow().then((r) => setNote(runResultText(r, (k, v) => t(k as MessageKey, v))));
          },
        },
      ],
    },
    {
      kind: "actions",
      key: "dp-presets",
      actions: PRESETS.map((p) => ({
        key: p.id,
        label: t(`tvplay.preset.${p.id}` as MessageKey),
        primary: manual.preset === p.id,
        onPress: () => save(applyPreset(manual, p.id), t("tvplay.device.preset_applied")),
      })),
    },
    {
      kind: "actions",
      key: "dp-reset",
      actions: [{ key: "reset", label: t("tvplay.device.reset"), onPress: () => save({ default_player: manual.default_player ?? null }) }],
    },
  );
  return { rows, note };
}
