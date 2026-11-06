# Marty in the «Каркас» wave-terrain style — art instructions

How to make Marty art (stickers, animations, wallpapers) that matches the
**«Каркас» (wireframe)** design: the synthwave **wave terrain** — neon wireframe
ridges rolling toward the viewer under a glowing horizon. Use it with any image
generator (Midjourney, DALL·E, Ideogram, Kling/Runway for animation…), then hand
the files over as described in [Delivery](#delivery) so they drop straight into
the app.

The existing cyberpunk pack (`packages/ui/src/marty/`) stays the default Marty;
wave-terrain art is a themed variant for «Каркас» (and anything synthwave).

---

## 1. The look in one sentence

> A small black plush robot-cat sitting on a glowing magenta wireframe terrain
> at night, deep purple sky, cyan rim light, retro-futuristic synthwave, clean
> and cute — not gritty.

## 2. Palette (from the app — use these exact colours)

| Role | Hex | Where in the app |
|---|---|---|
| Background (sky) | `#0D0420` | `--mt-bg` |
| Surface (terrain fill) | `#1E0F3D` | `--mt-surface` |
| Surface 2 | `#2E1858` | `--mt-surface-2` |
| Grid lines / borders | `#5C369C` | `--mt-border` |
| **Accent — magenta neon** (ridges, eyes, play icon) | `#FF4FD8` | `--mt-accent` |
| **Accent 2 — cyan neon** (rim light, focus, highlights) | `#3CE8FF` | `--mt-accent-strong` / focus |
| Text / stars | `#F6EFFF` | `--mt-text` |
| Muted | `#C4B2E6` | `--mt-muted` |
| Ink on accent | `#160420` | `--mt-on-accent` |

Rules: magenta is the main light source, cyan only as a thin rim/edge light.
No lime (that's «Кинозал»), no yellow (that's «Киберпанк»), no orange sunsets
(that's «Ретро 80»).

## 3. Motifs

- **Wave terrain:** 8–14 parallel wireframe ridges (sine-like hills), drawn as
  thin glowing magenta lines with the fill the same colour as the sky, so
  nearer ridges hide farther ones. Perspective toward a horizon in the upper third.
- **Horizon glow:** a soft magenta ellipse behind the horizon (no hard sun disc).
- **Stars:** few, small four-point sparkles in `#F6EFFF`, some magenta.
- **Type:** «marty» in a heavy rounded display face (Unbounded 800), «tv» in a
  magenta pill with dark ink. Labels in JetBrains Mono.
- **Shapes:** small corner radii (6–8 px); thin 1–2 px lines; glow, not blur.

## 4. Marty — character sheet (keep him consistent)

Always the same character as the cyberpunk pack; only the lighting changes.

- Small, chunky, **plush/quilted black** robot-cat in a hood with two cat ears.
- Face: a dark visor with **two tall glowing oval eyes** (magenta here), no
  mouth, no nose. Expressions come only from the eyes (arcs = happy, `-` =
  sleepy, `×` = error, stars = excited, ring = loading, `?`/`!` floating).
- A small **backpack/side box with a glowing ▷ play icon** on his left side.
- Sitting pose by default, round paws, short tail.
- Lighting: magenta key light from the terrain below/front, **thin cyan rim**
  on the hood and ears. Soft reflection under him on the terrain.
- Proportions: head ≈ 55% of height; chibi, cute, readable at 32 px.
- Never: realistic fur, a mouth, human hands, text on his body, other
  characters, extra limbs.

## 5. Prompts (copy, paste, adjust the bracket)

**Base character (single sticker, transparent background)**

```
cute chibi robot cat mascot named Marty, small black quilted plush body in a hood with two cat ears,
dark visor face with two tall glowing magenta oval eyes, no mouth, small side box with a glowing play
triangle icon, sitting, round paws, thin cyan rim light on hood and ears, magenta glow from below,
synthwave retro-futuristic style, clean vector-like 3D render, high contrast, centered, full body,
[EXPRESSION], isolated on transparent background, sticker, no text
```

`[EXPRESSION]` examples matching the app moods:
`idle` → calm, eyes open · `happy` → eyes as upward arcs ^^ · `excited` → star-shaped eyes, sparkles ·
`love` → holding a glowing pink heart · `sleepy` → eyes as thin lines, small "z z" ·
`thinking` → head tilted, floating cyan "?" · `surprised` → wide eyes, floating "!" ·
`error` → eyes as glowing "×" · `loading` → one eye a spinning cyan ring ·
`popcorn` → holding a striped popcorn bucket · `music` → wearing neon headphones ·
`laptop` → typing on a glowing laptop · `rain` → under a neon umbrella in rain · `run` → running with speed lines.

**Sticker sheet (all moods at once, same character)**

```
character sticker sheet, 4 rows × 6 columns, the same cute chibi robot cat mascot (black quilted plush
hood with cat ears, dark visor with two glowing magenta oval eyes, no mouth, side box with glowing play icon,
thin cyan rim light) in different poses and emotions: idle, happy, excited with star eyes, holding a heart,
headphones, sleeping with zzz, curious with question mark, surprised with exclamation mark, error with X eyes,
loading ring eye, eating popcorn, typing on laptop, under umbrella in rain, running, sly smirk eyes,
on a small glowing magenta wireframe terrain patch, synthwave palette deep purple #0D0420, magenta #FF4FD8,
cyan #3CE8FF, consistent design across all stickers, evenly spaced, transparent background, no text
```

**Wallpaper / key art (TV 16:9, Home or intro background)**

```
synthwave night landscape, endless wireframe wave terrain made of glowing magenta lines rolling toward the
viewer, deep purple sky #0D0420, soft magenta horizon glow, a few small sparkling stars, cute chibi black
robot cat mascot with glowing magenta eyes sitting on the nearest ridge in the lower left third, thin cyan rim
light, calm, cinematic, minimal, lots of empty space on the right for UI, 16:9, 3840x2160, no text
```

**Idle animation (image-to-video; start from the base sticker)**

```
subtle seamless idle loop, the robot cat sits still and breathes gently, blinks once (eyes squash to lines and
back), ears twitch slightly, the magenta glow under him pulses softly, camera static, no background change,
loopable, 2 seconds
```

Negative prompt (where supported): `mouth, teeth, realistic fur, human hands, text, watermark, logo, extra limbs,
gritty, dirty, photo, lime green, yellow, orange sun`.

## 6. Delivery

So the files work in the app without manual fixing:

| Asset | Format | Size | Notes |
|---|---|---|---|
| Mood sticker | PNG or WebP with **transparent** background | ≥ 512 px on the long side | one mood per file, named by mood (`happy.png`…) or one sheet |
| Mood animation | animated WebP (or GIF/MP4 — converted) | ~480 px, 8–14 frames, ~150–200 ms per frame, **seamless loop** | transparent background; first and last frame match |
| Wallpaper | PNG/JPG | 3840×2160 (16:9) | keep the right ⅔ calm for the UI |
| App icon | PNG | 1024×1024, square, full-bleed | the app rounds the corners itself; keep Marty inside the central 80% |

Mood names the app understands: `idle, happy, excited, love, music, sleepy, thinking, surprised, error,
loading, popcorn, laptop, rain, run, sly` (see `packages/ui/src/marty/index.ts`).

Drop the files anywhere (e.g. `~/Downloads`) and ask Claude to add them:
they're trimmed to their visible area, resized (stickers ≤ 320 px, loops ≤ 200–256 px,
≈ 100–180 KB each) and wired to the moods. Animated loops are shown only where
Marty is big (≥ 80 px) or explicitly animated, and never with «reduce motion».
