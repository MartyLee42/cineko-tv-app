// WCAG contrast of the design tokens in theme.css (pure; used by themeContrast.test.ts as a guard,
// the rendered screens are checked by e2e/scripts/contrast-audit.mjs).

export type Rgb = readonly [number, number, number];

/** Token blocks of a theme.css: selector ("html.design-mult", ":root") → token name (no `--mt-`) → colour. */
export function parseTokenBlocks(css: string): Map<string, Map<string, Rgb>> {
  const out = new Map<string, Map<string, Rgb>>();
  for (const m of css.matchAll(/(:root|html\.design-[\w.-]+)\s*\{([^}]*)\}/g)) {
    const toks = new Map<string, Rgb>();
    for (const t of m[2]!.matchAll(/--mt-([\w-]+):\s*(\d+),\s*(\d+),\s*(\d+)\s*;/g)) toks.set(t[1]!, [Number(t[2]), Number(t[3]), Number(t[4])]);
    if (toks.size) out.set(m[1]!, toks);
  }
  return out;
}

/** A design's tokens: :root, then the design's own block on top. */
export function designTokens(blocks: Map<string, Map<string, Rgb>>, selector: string): Map<string, Rgb> {
  return new Map([...(blocks.get(":root") ?? []), ...(blocks.get(selector) ?? [])]);
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio, 1…21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
