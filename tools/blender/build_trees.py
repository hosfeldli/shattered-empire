# Trees for the terrain: a painted leaf atlas and card-crowned tree meshes.
#
#   FoliageAtlas.png (Resources/Textures): left half a broadleaf twig cluster, right half a fir sprig, painted
#     leaf by leaf and needle by needle into an RGBA image (alpha-tested in SE/InstancedLit, surface Foliage).
#     The colour is a light, nearly neutral detail layer: the tree's instance colour supplies the hue, so
#     groves, autumn stands and burnt woods still tint correctly.
#   TreeBroadleaf / TreeBroadleafLo / TreeFir / TreeFirLo (.bytes, SEM1): a tapered, curving trunk with root
#     flare and limbs, and a crown of crossed leaf-cluster cards. Card normals point out of the crown volume
#     (not along each card), so a crown lights like one leafy mass with a bright sunlit side and a shaded
#     side, instead of a scatter of dark shards. Cards deep in the crown carry baked occlusion.
#   Trees are ~1 unit tall; the terrain scales them to 11-17 m.
#
#   headless:  "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_trees.py -- <models dir> <textures dir>
import sys, os, math, random, struct
import numpy as np

if '--' in sys.argv:
    OUT = sys.argv[sys.argv.index('--') + 1]
    TEX = sys.argv[sys.argv.index('--') + 2]
else:
    OUT = TEX = os.path.join(os.getcwd(), 'out')
PLAIN, FOLIAGE = 0, 12

# ------------------------------------------------------------------ atlas
W, H = 1024, 512
img = np.zeros((H, W, 4), np.float32)   # row 0 = bottom (Blender and Unity UV convention)
YY, XX = np.mgrid[0:H, 0:W].astype(np.float32)


def paint(x0, x1, y0, y1, alpha, rgb):
    """Composite a coverage mask (alpha) with colour rgb (HxWx3 or 3) over the image region."""
    reg = img[y0:y1, x0:x1]
    a = np.clip(alpha, 0, 1)[..., None]
    reg[..., :3] = reg[..., :3] * (1 - a) + np.asarray(rgb, np.float32) * a
    reg[..., 3:] = reg[..., 3:] * (1 - a) + a


def leaf(px, py, ang, length, width, base, rnd, needle=False):
    ca, sa = math.cos(ang), math.sin(ang)
    ex, ey = px + ca * length, py + sa * length
    pad = width + 2
    x0, x1 = int(max(0, min(px, ex) - pad)), int(min(W, max(px, ex) + pad + 1))
    y0, y1 = int(max(0, min(py, ey) - pad)), int(min(H, max(py, ey) + pad + 1))
    if x1 <= x0 or y1 <= y0: return
    dx, dy = XX[y0:y1, x0:x1] - px, YY[y0:y1, x0:x1] - py
    a = dx * ca + dy * sa            # along the leaf
    b = -dx * sa + dy * ca           # across
    t = np.clip(a / length, 0, 1)
    if needle: half = width * (1 - t * .7)
    else: half = width * np.power(np.maximum(np.sin(np.pi * t), 0), .75) * (1 - .25 * t)
    inside = np.clip(half - np.abs(b) + .5, 0, 1) * (a >= -.5) * (a <= length + .5)
    edge = 1 - np.clip(np.abs(b) / np.maximum(half, .01), 0, 1)
    shade = base * (.72 + .28 * edge)
    if not needle:
        shade = shade + (np.abs(b) < 1.1) * .10 * (t < .92)                      # midrib
        shade = shade * (1 - .12 * np.clip((t - .55) * 2, 0, 1) * (b > 0))        # curled half in shadow
    tint = np.array([.84, 1.0, .74]) if not needle else np.array([.80, 1.0, .86])
    rgb = np.clip(shade[..., None] * tint, 0, 1)
    paint(x0, x1, y0, y1, inside, rgb)


def stem(p0, p1, r0, r1, col):
    (ax, ay), (bx, by) = p0, p1
    x0, x1 = int(max(0, min(ax, bx) - r0 - 2)), int(min(W, max(ax, bx) + r0 + 3))
    y0, y1 = int(max(0, min(ay, by) - r0 - 2)), int(min(H, max(ay, by) + r0 + 3))
    dx, dy = XX[y0:y1, x0:x1] - ax, YY[y0:y1, x0:x1] - ay
    vx, vy = bx - ax, by - ay
    L2 = max(vx * vx + vy * vy, 1e-6)
    t = np.clip((dx * vx + dy * vy) / L2, 0, 1)
    d = np.hypot(dx - t * vx, dy - t * vy)
    r = r0 + (r1 - r0) * t
    paint(x0, x1, y0, y1, np.clip(r - d + .5, 0, 1), col)


rnd = random.Random(11)
# broadleaf cluster: a forked twig carrying ~110 leaves, growing up the card
twigs = []
def grow(x, y, ang, length, depth):
    ex, ey = x + math.cos(ang) * length, y + math.sin(ang) * length
    twigs.append(((x, y), (ex, ey), 3.2 - depth * .9, 1.6 - depth * .4))
    if depth < 2:
        for k in range(3 if depth == 0 else 2):
            t = .35 + k * .25 + rnd.uniform(-.05, .05)
            sx, sy = x + (ex - x) * t, y + (ey - y) * t
            grow(sx, sy, ang + (1 if k % 2 else -1) * rnd.uniform(.45, .8), length * rnd.uniform(.45, .6), depth + 1)
grow(256, 8, math.pi / 2 + .05, 470, 0)
for p0, p1, r0, r1 in twigs: stem(p0, p1, r0, r1, (.30, .27, .22))
for p0, p1, r0, r1 in twigs:
    n = int(math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 10)
    ang0 = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    for k in range(n):
        t = (k + 1) / (n + 1)
        x, y = p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t
        if y < 60: continue
        side = 1 if k % 2 else -1
        ang = ang0 + side * rnd.uniform(.55, 1.15)
        L = rnd.uniform(34, 58) * (1 - .25 * t)
        leaf(x, y, ang, L, L * .30, rnd.uniform(.42, .70), rnd)
    leaf(p1[0], p1[1], ang0 + rnd.uniform(-.2, .2), 60, 18, rnd.uniform(.5, .7), rnd)

# fir sprig: a stem with paired branchlets, every stem densely set with needles
def needles(p0, p1, density, length):
    L = math.hypot(p1[0] - p0[0], p1[1] - p0[1]); ang0 = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    for k in range(int(L / density)):
        t = k * density / L
        x, y = p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t
        for side in (-1, 1):
            leaf(x, y, ang0 + side * rnd.uniform(.55, .95), length * rnd.uniform(.8, 1.15) * (1 - .35 * t), 2.3, rnd.uniform(.32, .52), rnd, needle=True)
cx = 768
main = ((cx, 6), (cx + 6, 500))
stem(main[0], main[1], 4, 1.5, (.28, .24, .20))
for k in range(9):
    y = 50 + k * 50; reach = 230 * (1 - k / 11) + 30
    for side in (-1, 1):
        a = math.pi / 2 - side * (1.0 - k * .03)
        p1 = (cx + math.cos(a) * reach, y + math.sin(a) * reach * .55)
        stem((cx, y), p1, 2.4, 1.0, (.28, .24, .20))
        needles((cx, y), p1, 4.5, 24)
needles(main[0], main[1], 4, 26)

def save_png(path):
    import bpy
    im = bpy.data.images.new('FoliageAtlas', W, H, alpha=True, float_buffer=False)
    im.pixels.foreach_set(img.reshape(-1))
    im.filepath_raw = path; im.file_format = 'PNG'
    im.save()
os.makedirs(TEX, exist_ok=True)
save_png(os.path.join(TEX, 'FoliageAtlas.png'))
print('[se] FoliageAtlas', W, H)

# ------------------------------------------------------------------ meshes (Unity space: y up)
def norm(v):
    l = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) or 1
    return (v[0] / l, v[1] / l, v[2] / l)
def add(a, b, s=1): return (a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s)
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


class Tree:
    def __init__(self): self.v, self.i = [], []

    def vert(self, p, n, c, s, uv):
        self.v.append((p, n, c, s, uv)); return len(self.v) - 1

    def tube(self, pts, radii, sides, col):
        rings = []
        for k, (p, r) in enumerate(zip(pts, radii)):
            d = norm(tuple(b - a for a, b in zip(pts[max(0, k - 1)], pts[min(len(pts) - 1, k + 1)])))
            side = norm(cross(d, (0, 0, 1) if abs(d[2]) < .9 else (1, 0, 0)))
            up = cross(side, d)
            ring = []
            for j in range(sides):
                a = j / sides * math.tau
                n = add(tuple(x * math.cos(a) for x in side), tuple(x * math.sin(a) for x in up))
                shade = .78 + .22 * (k / max(1, len(pts) - 1))
                c = tuple(int(255 * min(1, ch * shade)) for ch in col)
                ring.append(self.vert(add(p, n, r), n, c, PLAIN, (0, 0)))
            rings.append(ring)
        for k in range(len(rings) - 1):
            for j in range(sides):
                a, b = rings[k][j], rings[k][(j + 1) % sides]
                c, d = rings[k + 1][j], rings[k + 1][(j + 1) % sides]
                self.i += [a, c, b, b, c, d]

    def card(self, center, right, up, uv0, uv1, normal_of, col):
        corners = [add(add(center, right, -1), up, -1), add(add(center, right, 1), up, -1),
                   add(add(center, right, 1), up, 1), add(add(center, right, -1), up, 1)]
        uvs = [(uv0[0], uv0[1]), (uv1[0], uv0[1]), (uv1[0], uv1[1]), (uv0[0], uv1[1])]
        ids = [self.vert(p, normal_of(p), col(p), FOLIAGE, uv) for p, uv in zip(corners, uvs)]
        self.i += [ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]]

    def write(self, name):
        path = os.path.join(OUT, name + '.bytes')
        with open(path, 'wb') as fh:
            fh.write(b'SEM1'); fh.write(struct.pack('<II', len(self.v), len(self.i)))
            for p, *_ in self.v: fh.write(struct.pack('<3f', *p))
            for _, n, *_ in self.v: fh.write(struct.pack('<3f', *n))
            for _, _, c, *_ in self.v: fh.write(struct.pack('<4B', c[0], c[1], c[2], 255))
            for _, _, _, s, _ in self.v: fh.write(struct.pack('<f', float(s)))
            for *_, uv in self.v: fh.write(struct.pack('<2f', *uv))
            fh.write(struct.pack('<%dI' % len(self.i), *self.i))
        print('[se]', name, len(self.v), 'verts', len(self.i) // 3, 'tris')


BARK = (.62, .47, .36)    # multiplied by the green instance tint -> grey-brown bark


def broadleaf(name, cards, sides):
    r = random.Random(5)
    t = Tree()
    # trunk: a gently leaning, tapering spine with a flared base
    spine = [(0, 0, 0), (.006, .12, .002), (.016, .26, -.006), (.012, .40, .004), (.0, .52, .01)]
    t.tube(spine, [.040, .030, .026, .022, .016], sides, BARK)
    for k in range(4):                                    # root flare
        a = k * math.pi / 2 + .4
        t.tube([(math.cos(a) * .055, -.01, math.sin(a) * .055), (math.cos(a) * .012, .07, math.sin(a) * .012)], [.012, .016], 4, BARK)
    center, rad = (0, .66, 0), (.34, .29, .34)
    limbs = 6 if sides > 5 else 4
    for k in range(limbs):                                # limbs reaching into the crown
        a = k * 2.39996 + .3
        start = (0, .34 + k * .035, 0)
        end = (math.cos(a) * .24, .62 + r.uniform(-.04, .1), math.sin(a) * .24)
        mid = ((start[0] + end[0]) * .45, (start[1] + end[1]) * .5 + .03, (start[2] + end[2]) * .45)
        t.tube([start, mid, end], [.015, .010, .004], 4, BARK)

    def outward(p):
        return norm(((p[0] - center[0]) / rad[0], (p[1] - center[1]) / rad[1] + .25, (p[2] - center[2]) / rad[2]))

    def shade(p):
        d = math.sqrt(sum(((p[j] - center[j]) / rad[j]) ** 2 for j in range(3)))
        k = .50 + .50 * min(1, d) + .12 * (p[1] - center[1]) / rad[1]
        return tuple(int(255 * max(0, min(1, ch * k))) for ch in (.86, .90, .80))

    for c in range(cards):
        # points biased to the crown's shell, so its silhouette is full and the interior is not wasted
        while True:
            d = (r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1))
            l = math.sqrt(sum(x * x for x in d))
            if .2 < l <= 1: break
        s = l ** .45
        p = (center[0] + d[0] / l * s * rad[0] * .86, center[1] + d[1] / l * s * rad[1] * .86, center[2] + d[2] / l * s * rad[2] * .86)
        out = norm((p[0], (p[1] - center[1]) * .6 + .18, p[2]))          # clusters grow outward and upward
        side = norm(cross(out, (r.uniform(-.3, .3), 1, r.uniform(-.3, .3))))
        size = r.uniform(.085, .125) * (1.25 if cards < 50 else 1)
        up = tuple(x * size for x in out); right = tuple(x * size * .95 for x in side)
        cen = add(p, out, size * .55)
        t.card(cen, right, up, (.005, .01), (.495, .99), outward, shade)
    t.write(name)


def fir(name, tiers, arms):
    r = random.Random(9)
    t = Tree()
    t.tube([(0, 0, 0), (0, .3, .004), (.004, .7, 0), (0, 1.02, 0)], [.030, .022, .012, .002], 6 if arms > 5 else 4, BARK)

    def outward(p):
        return norm((p[0], .55 + (p[1] - .55) * .3, p[2]))

    def shade(p):
        reach = math.hypot(p[0], p[2]); top = (p[1] - .12) / .9
        k = .45 + .45 * min(1, reach / .2) + .15 * top
        return tuple(int(255 * max(0, min(1, ch * k))) for ch in (.80, .86, .80))

    for k in range(tiers):
        y = .14 + k * (.84 / tiers)
        reach = .30 * (1 - (y - .14) / .92) ** .85 + .045
        for j in range(arms):
            a = j * math.tau / arms + k * 1.21 + r.uniform(-.15, .15)
            radial = (math.cos(a), 0, math.sin(a))
            droop = -.32 - .15 * (1 - k / tiers)
            along = norm((radial[0], droop * .6 + .25, radial[2]))           # branches lift, then droop at the tips
            side = norm(cross(along, (0, 1, 0)))
            side = norm(add(side, (0, 1, 0), .35))                           # tilt so the sprig catches the light
            half = reach * .55
            up = tuple(x * half for x in along); right = tuple(x * half * .78 for x in side)
            t.card(add((0, y, 0), along, half), right, up, (.505, .01), (.995, .99), outward, shade)
    for a in (0, math.pi / 3, 2 * math.pi / 3):                              # the leader
        right = (math.cos(a) * .045, 0, math.sin(a) * .045)
        t.card((0, .97, 0), right, (0, .07, 0), (.505, .01), (.995, .99), outward, shade)
    t.write(name)


os.makedirs(OUT, exist_ok=True)
broadleaf('TreeBroadleaf', 128, 8)
broadleaf('TreeBroadleafLo', 52, 5)
fir('TreeFir', 14, 9)
fir('TreeFirLo', 8, 5)
