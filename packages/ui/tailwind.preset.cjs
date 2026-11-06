// Shared Tailwind (v3) preset. Tailwind 3 is used instead of v4 because v4's
// CSS needs Chrome 111+, and many TV browsers run much older engines.
//
// Everything visual is a CSS variable (see src/theme.css) so the design
// (Кинозал / Терминал / Проектор) and light/dark can switch at runtime.
// Colours are comma-separated RGB triplets used with rgba(): the
// space-separated `rgb(r g b / a)` syntax isn't supported by Chrome < 65.
const v = (name) => `rgba(var(--mt-${name}), <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: v("surface"),
        "surface-2": v("surface-2"),
        border: v("border"),
        text: v("text"),
        muted: v("muted"),
        accent: v("accent"),
        "accent-strong": v("accent-strong"),
        "on-accent": v("on-accent"),
        focus: v("focus"),
        danger: v("danger"),
        ok: v("ok"),
        warn: v("warn"),
      },
      fontFamily: {
        sans: ["var(--mt-font-body)"],
        display: ["var(--mt-font-display)"],
        label: ["var(--mt-font-label)"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      borderRadius: {
        card: "var(--mt-radius-card)",
        control: "var(--mt-radius-control)",
      },
    },
  },
};
