// TV health («Состояние»): what a TV reports about its own load (web Devices
// page, Admin → Devices, TV «About this TV» and the reporting switch). ru must
// mirror en.
export const healthEn = {
  "health.title": "Health",
  "health.heap": "App memory {used} / {limit} MB",
  "health.heap_used": "App memory {used} MB",
  "health.ram": "RAM ~{gb} GB",
  "health.cores_one": "{n} core",
  "health.cores_few": "{n} cores",
  "health.cores_many": "{n} cores",
  "health.fps": "{fps} fps",
  "health.lag": "lag {ms} ms",
  "health.dropped": "dropped frames {pct}%",
  "health.long_tasks": "freezes {n} ({ms} ms)",
  "health.range": "fps {min}–{max} over {n} reports",
  "health.none": "no reports yet",
  "health.not_sending": "not reporting",
  "health.last": "last {when}",
  "health.hint_slow": "The TV is struggling — try «Calm» animations or a simpler design.",
  "health.hint_memory": "The app is short on memory — restart it on the TV.",
  "health.setting": "Report TV health (memory, smoothness)",
  "health.setting_hint": "Every 10 minutes and after watching: app memory, frame rate, delays, dropped frames. Visible to the TV's owner on the Devices page.",
  "health.now": "Health now",
  "health.measuring": "Measuring…",
  "health.unavailable": "this TV's browser doesn't tell",
  "health.reporting_off": "reporting is off",
} as const;
