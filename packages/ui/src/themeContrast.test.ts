import { describe, expect, it } from "vitest";
import base from "./theme-base.css?raw";
import t_anderson from "./themes/anderson.css?raw";
import t_constructivism from "./themes/constructivism.css?raw";
import t_cyberpunk from "./themes/cyberpunk.css?raw";
import t_deco from "./themes/deco.css?raw";
import t_matrix from "./themes/matrix.css?raw";
import t_mult from "./themes/mult.css?raw";
import t_noir from "./themes/noir.css?raw";
import t_odyssey from "./themes/odyssey.css?raw";
import t_pocketpet from "./themes/pocketpet.css?raw";
import t_popart from "./themes/popart.css?raw";
import t_projector from "./themes/projector.css?raw";
import t_redroom from "./themes/redroom.css?raw";
import t_retro80 from "./themes/retro80.css?raw";
import t_retro90 from "./themes/retro90.css?raw";
import t_silent from "./themes/silent.css?raw";
import t_stickerbook from "./themes/stickerbook.css?raw";
import t_tarkovsky from "./themes/tarkovsky.css?raw";
import t_terminal from "./themes/terminal.css?raw";
import t_vague from "./themes/vague.css?raw";
import t_western from "./themes/western.css?raw";
import t_fivestars from "./themes/fivestars.css?raw";
import t_wireframe from "./themes/wireframe.css?raw";

// Each design's tokens live in themes/<id>.css (loaded with the design's chunk); the base has :root and Кинозал.
const designFiles: Record<string, string> = { "anderson": t_anderson, "constructivism": t_constructivism, "cyberpunk": t_cyberpunk, "deco": t_deco, "fivestars": t_fivestars, "matrix": t_matrix, "mult": t_mult, "noir": t_noir, "odyssey": t_odyssey, "pocketpet": t_pocketpet, "popart": t_popart, "projector": t_projector, "redroom": t_redroom, "retro80": t_retro80, "retro90": t_retro90, "silent": t_silent, "stickerbook": t_stickerbook, "tarkovsky": t_tarkovsky, "terminal": t_terminal, "vague": t_vague, "western": t_western, "wireframe": t_wireframe };
const css = [base, ...Object.values(designFiles)].join("\n");
import { DESIGNS } from "./designs";
import { contrast, designTokens, parseTokenBlocks, type Rgb } from "./themeContrast";

const blocks = parseTokenBlocks(css);
// Кинозал's dark tokens are :root; its light theme and every other design have their own block.
const selectors = [":root", "html.design-kinozal.theme-light", ...DESIGNS.filter((d) => d !== "kinozal").map((d) => `html.design-${d}`)];

describe("theme contrast", () => {
  it("has a token file for every design (add new ones to the imports above)", () => {
    expect(DESIGNS.filter((d) => d !== "kinozal" && !(d in designFiles))).toEqual([]);
  });

  it("contrast() follows WCAG", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2);
    expect(contrast([10, 20, 30], [10, 20, 30])).toBe(1);
  });

  it("every design reads at 4.5:1: text and muted on all grounds; accent-as-text and status colours on bg/surface; on-accent on accent", () => {
    const failures: string[] = [];
    for (const sel of selectors) {
      expect(blocks.has(sel), sel).toBe(true);
      const t = designTokens(blocks, sel);
      const get = (k: string): Rgb => t.get(k)!;
      const check = (label: string, fg: Rgb, bg: Rgb) => {
        const r = contrast(fg, bg);
        if (r < 4.5) failures.push(`${sel} ${label} ${r.toFixed(2)}`);
      };
      for (const ground of ["bg", "surface", "surface-2"]) {
        check(`text/${ground}`, get("text"), get(ground));
        check(`muted/${ground}`, get("muted"), get(ground));
      }
      for (const ground of ["bg", "surface"]) {
        check(`accent-text/${ground}`, t.get("accent-text") ?? get("accent"), get(ground));
        for (const status of ["ok", "danger", "warn"]) check(`${status}/${ground}`, get(status), get(ground));
      }
      check("on-accent/accent", get("on-accent"), get("accent"));
    }
    expect(failures).toEqual([]);
  });
});
