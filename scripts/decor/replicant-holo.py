# Bakes Cineko's idle sticker into a hologram: translucent violet→pink, bright edges, scanlines,
# a few glitch-shifted rows, dissolving towards the base. Usage: holo.py <in.webp> <out.webp>
import sys, random
from PIL import Image, ImageFilter, ImageChops
src = Image.open(sys.argv[1]).convert("RGBA")
S = 2.6
im = src.resize((int(src.width * S), int(src.height * S)), Image.LANCZOS)
W, H = im.size
r, g, b, a = im.split()
lum = Image.merge("RGB", (r, g, b)).convert("L")
# Edges: the rim light, made brighter so the dark body still reads as a shape.
edge = lum.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(1.2))
px_l, px_a, px_e = lum.load(), a.load(), edge.load()
out = Image.new("RGBA", (W, H))
po = out.load()
rnd = random.Random(7)
glitch = {}
for _ in range(9):
    y0 = rnd.randrange(int(H * 0.1), int(H * 0.8)); h = rnd.randrange(3, 10); dx = rnd.choice([-1, 1]) * rnd.randrange(10, 34)
    for y in range(y0, min(H, y0 + h)): glitch[y] = dx
LAV, LAV2 = (138, 150, 255), (196, 186, 255)
VIOLET, PINK, CYAN, WHITE = (176, 80, 255), (255, 70, 196), (120, 220, 255), (255, 226, 248)
def mix(c1, c2, t): return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
for y in range(H):
    fade = 1.0 if y < H * 0.62 else max(0.0, 1 - (y - H * 0.62) / (H * 0.38)) ** 1.4
    scan = 0.5 if y % 4 == 0 else (0.82 if y % 4 == 1 else 1.0)
    dx = glitch.get(y, 0)
    for x in range(W):
        sx = x - dx
        if not (0 <= sx < W): continue
        al = px_a[sx, y]
        if al == 0: continue
        L = px_l[sx, y] / 255; E = min(1, px_e[sx, y] / 90)
        t = min(1, L ** 0.6 * 1.3 + E * 0.6)
        # Body violet → pink; the left edges lean cyan (the projector's fringe); hot spots near white.
        # Vertical grade like a projected figure: lavender-blue crown, magenta middle, hot pink lower down.
        v = y / H
        base = mix(LAV, VIOLET, min(1, v / 0.4)) if v < 0.4 else mix(VIOLET, PINK, min(1, (v - 0.4) / 0.35))
        c = mix(base, PINK if v > 0.3 else LAV2, min(1, t * 0.9))
        if t > 0.75: c = mix(c, WHITE, (t - 0.75) / 0.25)
        if x < W * 0.35: c = mix(c, CYAN, 0.18 * (1 - x / (W * 0.35)))
        alpha = (al / 255) * (0.42 + 0.58 * t) * scan * fade
        if dx: alpha *= 0.8; c = mix(c, CYAN, 0.35)
        po[x, y] = (*c, int(alpha * 255))
out.save(sys.argv[2], "WEBP", quality=72, method=6)
print(W, H)
