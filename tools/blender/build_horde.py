# The Blight's creatures (BLIGHT survival mode), sculpted in Blender and baked in three levels of detail.
#   "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_horde.py -- <models dir> [Crawler Husk ...]
#
# Every design here is original. Each creature is laid out as overlapping organic parts (ellipsoid blobs and
# tapered tubes) in game space (x right, y up, z forward; standing on y = 0, facing +z, about one unit long or
# tall; HordeRenderer scales them). The parts then go through a sculpting pass:
#   LOD0  parts -> voxel remesh (fuses them into one flesh surface) -> relax -> procedural sculpt (lumpy flesh,
#         tumour clusters, wrinkle creases, all along the normal) -> decimate to the triangle budget
#   LOD1  LOD0 decimated again (about a third)
#   LOD2  the parts as bare low-poly primitives (silhouette only: no remesh, tiny details dropped)
# and every vertex is coloured and tagged from the parts it lies on (a soft nearest-part blend, so colour and
# animation weights fade across the seams instead of stepping).
#
# Output: Resources/Models/Horde_<Kind><lod>.bytes in the SEM1 layout read by ModelLibrary (positions and normals in
# Unity space, u8x4 colour, float surface, float2 uv0, u32 indices), with the channels used by SE/HordeLit:
#   colour.rgb  palette x mottling x veins x ray-traced ambient occlusion x ground grime
#   colour.a    255 x (1 - glow): bile sacs, pustules and eyes glow (the code-built fallback keeps alpha 255)
#   uv0.x       animation region + phase (fraction, in turns): which vertex shader motion applies and its offset
#   uv0.y       animation weight 0..1 (0 where a limb joins the body, 1 at its tip)
#   surface     0 (SE/HordeLit shades flesh itself)
# Regions (must match HordeLit.shader and HordeMeshes.cs):
#   0 body (rigid)  1 leg (gait swing and lift)  2 arm (swings about the kind's shoulder pivot)  3 sac (pulses along
#   the normal)  4 head (tremor and strike snap)  5 spine/stalk/tendril (sway)  6 jaw/mouth (opens toward its phase
#   direction: 0 -x, .25 up, .5 +x, .75 down)
import bpy, bmesh, sys, os, math, struct, random
from mathutils import Vector, noise
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = args[0] if args else os.path.join(os.getcwd(), 'out')
ONLY = set(args[1:])
os.makedirs(OUT, exist_ok=True)

BODY, LEG, ARM, SAC, HEAD, SPINE, JAW = range(7)

# A sickly palette no team colour shares (sRGB, like every SEM1 vertex colour).
COL = {
    'flesh': (.64, .59, .44), 'fleshdark': (.43, .37, .30), 'bruise': (.38, .22, .31), 'bile': (.58, .72, .18),
    'biledark': (.27, .34, .11), 'bone': (.78, .72, .56), 'sinew': (.52, .14, .12), 'rot': (.21, .23, .14),
    'uniform': (.31, .34, .24), 'pus': (.88, .82, .44), 'membrane': (.76, .71, .50), 'gum': (.42, .11, .14),
    'eye': (.93, .90, .42),
}
# How strongly the sculpt pass deforms each material (bone and eyes stay smooth, rot is the lumpiest).
DETAIL = {'flesh': 1., 'fleshdark': 1., 'bruise': 1.25, 'bile': .55, 'biledark': .8, 'bone': .45, 'sinew': .75,
          'rot': 1.4, 'uniform': .45, 'pus': .3, 'membrane': .3, 'gum': .8, 'eye': 0.}
FLESHY = {'flesh', 'fleshdark', 'bruise', 'rot', 'membrane', 'uniform'}


def B(p):
    """Game space (x, y up, z forward) -> Blender (x, y forward, z up)."""
    return (p[0], p[2], p[1])


class Part:
    """An ellipsoid blob or a tapered tube chain, with its colour and animation tags (all stored in Blender space)."""

    def __init__(self, col, region, phase, weights, glow, lod2):
        self.col, self.region, self.phase, self.weights, self.glow, self.lod2 = col, region, phase, weights, glow, lod2
        self.rgb = COL[col]
        self.detail = DETAIL[col]

    def weight(self, t):
        w = self.weights
        if len(w) == 1: return w[0]
        f = t * (len(w) - 1)
        i = min(int(f), len(w) - 2)
        return w[i] + (w[i + 1] - w[i]) * (f - i)


class Blob(Part):
    def __init__(self, c, r, col, region=BODY, w=0., phase=0., glow=0., lod2=True):
        super().__init__(col, region, phase, (w,), glow, lod2)
        self.c, self.r = B(c), B(r)

    def sd(self, x, y, z):
        cx, cy, cz = self.c; rx, ry, rz = self.r
        qx, qy, qz = (x - cx) / rx, (y - cy) / ry, (z - cz) / rz
        k0 = math.sqrt(qx * qx + qy * qy + qz * qz)
        k1 = math.sqrt((qx / rx) ** 2 + (qy / ry) ** 2 + (qz / rz) ** 2)
        if k1 < 1e-9: return -min(self.r), 0.
        return k0 * (k0 - 1) / k1, 0.

    def build(self, bm, segs, rings):
        res = bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1)
        for v in res['verts']:
            v.co = Vector((self.c[0] + v.co.x * self.r[0], self.c[1] + v.co.y * self.r[1], self.c[2] + v.co.z * self.r[2]))


class Tube(Part):
    """Points (x, y, z, radius) in game space; weights per point (or one value)."""

    def __init__(self, pts, col, region=BODY, w=(0.,), phase=0., glow=0., lod2=True):
        super().__init__(col, region, phase, tuple(w), glow, lod2)
        self.pts = [(B(p[:3]), p[3]) for p in pts]
        self.segs = []
        n = len(self.pts) - 1
        for i in range(n):
            (a, ra), (b, rb) = self.pts[i], self.pts[i + 1]
            d = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
            l2 = max(d[0] ** 2 + d[1] ** 2 + d[2] ** 2, 1e-12)
            self.segs.append((a, d, l2, ra, rb, i / n, (i + 1) / n))

    def sd(self, x, y, z):
        best, bt = 1e9, 0.
        for a, d, l2, ra, rb, t0, t1 in self.segs:
            px, py, pz = x - a[0], y - a[1], z - a[2]
            h = (px * d[0] + py * d[1] + pz * d[2]) / l2
            h = 0. if h < 0 else 1. if h > 1 else h
            ex, ey, ez = px - d[0] * h, py - d[1] * h, pz - d[2] * h
            dist = math.sqrt(ex * ex + ey * ey + ez * ez) - (ra + (rb - ra) * h)
            if dist < best: best, bt = dist, t0 + (t1 - t0) * h
        return best, bt

    def build(self, bm, segs, joints):
        for a, d, l2, ra, rb, t0, t1 in self.segs:
            dv = Vector(d); length = math.sqrt(l2)
            rot = Vector((0, 0, 1)).rotation_difference(dv.normalized()).to_matrix().to_4x4()
            from mathutils import Matrix
            m = Matrix.Translation(Vector(a) + dv * .5) @ rot
            bmesh.ops.create_cone(bm, cap_ends=joints, cap_tris=False, segments=segs, radius1=max(ra, .002),
                                  radius2=max(rb, .0015), depth=length, matrix=m)
        if joints:   # round the joints so the remesh fuses smooth elbows and knees
            for (p, r) in self.pts[:-1]:
                res = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=max(r, .002))
                for v in res['verts']: v.co += Vector(p)


# ============================================================================================ the creatures
def crawler():
    """A low, many-legged knot of claws: a long body slung between six high-kneed legs, a cluster of glowing bead
    eyes, splayed mandibles over a gum-red jaw, bone spines down the back and a rope of entrails dragging behind."""
    P = [Blob((0, .32, -.05), (.24, .17, .42), 'flesh'),
         Blob((0, .38, -.36), (.2, .17, .21), 'bruise'),
         Blob((.05, .42, .08), (.15, .11, .17), 'bruise'),
         Blob((-.1, .41, -.14), (.08, .07, .09), 'pus', glow=.25, lod2=False),
         Blob((0, .31, .42), (.13, .11, .15), 'fleshdark', HEAD, 1.),
         Blob((0, .39, .45), (.1, .045, .08), 'bone', HEAD, 1.),
         Blob((0, .22, .49), (.09, .05, .11), 'gum', JAW, 1., .75)]
    for e in ((.06, .36, .53), (-.05, .37, .52), (.02, .4, .5), (-.085, .33, .5), (.095, .33, .49), (-.01, .34, .56)):
        P.append(Blob(e, (.024, .024, .022), 'eye', HEAD, 1., glow=.95, lod2=False))
    for s in (-1, 1):
        P.append(Tube([(s * .06, .27, .5, .032), (s * .13, .22, .64, .018), (s * .1, .16, .75, .004)], 'bone', JAW, (.3, 1, 1), 0. if s < 0 else .5))
        for k in range(3):
            z = -.25 + k * .25
            flare = s * (.05 if k == 1 else 0)
            ph = ((k + (1 if s > 0 else 0)) % 2) * .5     # alternating tripods
            hip, knee = (s * .16, .32, z), (s * (.52 + flare), .6, z + (k - 1) * .16)
            ankle, tip = (s * .72, .1, z + (k - 1) * .32), (s * .76, 0, z + (k - 1) * .36)
            P.append(Tube([hip + (.058,), knee + (.036,)], 'fleshdark', LEG, (0, .6), ph))
            P.append(Tube([knee + (.034,), ankle + (.016,), tip + (.004,)], 'bone', LEG, (.6, 1, 1), ph))
            P.append(Tube([knee + (.02,), (knee[0] + s * .05, knee[1] + .09, knee[2] - .03, .004)], 'bone', LEG, (.6, .6), ph, lod2=False))
    for k in range(5):
        x = ((k % 2) - .5) * .09
        P.append(Tube([(x, .44, -.34 + k * .15, .03), (x * 1.6, .58 + k * .015, -.41 + k * .15, .012), (x * 1.9, .66 + k * .02, -.47 + k * .15, .003)],
                      'bone', SPINE, (0, .6, 1), k * .19, lod2=k % 2 == 0))
    P.append(Tube([(0, .28, -.5, .045), (.06, .16, -.7, .03), (-.03, .05, -.86, .019), (.02, .015, -.97, .01)], 'sinew', SPINE, (0, .4, .8, 1), .3))
    return P


def husk():
    """A soldier the Blight raised: hunched over a chest burst open by a glowing bile growth, ribs curling out, the
    head lolled on a stretched neck with one pin-point eye, a long clawed arm dragging and fungal stalks with glowing
    caps bursting from the back of the tattered uniform."""
    P = [Tube([(.08, .47, .02, .07), (.1, .25, .07, .06), (.08, .05, -.01, .05)], 'uniform', LEG, (0, .5, 1), 0.),
         Blob((.08, .035, .04), (.05, .035, .085), 'rot', LEG, 1., 0.),
         Tube([(-.08, .47, 0, .07), (-.1, .24, .1, .06), (-.09, .05, .06, .05)], 'uniform', LEG, (0, .5, 1), .5),
         Blob((-.09, .035, .1), (.05, .035, .085), 'rot', LEG, 1., .5),
         Tube([(-.11, .25, .12, .032), (-.095, .08, .09, .024)], 'bone', LEG, (.5, 1), .5, lod2=False),
         Blob((0, .48, .02), (.14, .08, .1), 'uniform'),
         Blob((0, .64, .08), (.17, .2, .13), 'uniform'),
         Blob((.05, .7, .18), (.11, .11, .09), 'bile', glow=.35),
         Blob((.04, .67, .22), (.06, .06, .05), 'pus', SAC, 1., glow=.9, lod2=False),
         Blob((-.12, .8, .02), (.1, .09, .09), 'bruise'),
         Blob((.03, .76, -.06), (.12, .1, .08), 'rot'),
         Tube([(0, .79, .09, .05), (.06, .87, .17, .045)], 'flesh', HEAD, (0, .6)),
         Blob((.09, .88, .2), (.08, .09, .085), 'flesh', HEAD, 1.),
         Blob((.12, .9, .27), (.024, .02, .016), 'gum', HEAD, 1., lod2=False),
         Blob((.06, .91, .275), (.013, .013, .011), 'eye', HEAD, 1., glow=1., lod2=False),
         Blob((.1, .82, .25), (.05, .03, .05), 'gum', JAW, 1., .75),
         # the long right arm and its claws; the shorter left arm ends in a mangled hand
         Tube([(.17, .76, .1, .05), (.24, .52, .2, .04), (.27, .3, .26, .032)], 'flesh', ARM, (0, .7, 1)),
         Tube([(-.17, .74, .06, .045), (-.21, .52, .17, .035), (-.19, .4, .26, .03)], 'uniform', ARM, (0, .7, 1)),
         Blob((-.19, .37, .27), (.035, .03, .04), 'flesh', ARM, 1.)]
    for d in (-1, 0, 1):
        P.append(Tube([(.27, .3, .26, .02), (.29 + d * .02, .17, .31, .009), (.3 + d * .035, .07, .33, .003)], 'bone', ARM, (1,), lod2=d == 0))
    for k in range(3):
        y = .76 - k * .05
        P.append(Tube([(.1, y, .17, .016), (.16, y - .02, .24, .01), (.13, y - .04, .29, .004)], 'bone', lod2=False))
    for k in range(4):
        base, tip = (-.04 + k * .035, .82, -.03), (-.1 + k * .065, 1. + (k % 2) * .05, -.12 - (k % 3) * .02)
        mid = ((base[0] + tip[0]) * .5 + .02, (base[1] + tip[1]) * .5, (base[2] + tip[2]) * .5 - .02)
        P.append(Tube([base + (.022,), mid + (.014,), tip + (.006,)], 'biledark', SPINE, (0, .6, 1), k * .23))
        P.append(Blob(tip, (.026, .02, .026), 'pus', SPINE, 1., k * .23, glow=.7, lod2=False))
    return P


def spitter():
    """A four-legged gullet: a long neck ending in a three-petalled mouth, slung under it a swollen, veined sac of
    glowing bile with brighter clots drifting inside, and a knotted hump over the haunches."""
    P = [Blob((0, .42, -.15), (.2, .17, .3), 'fleshdark'),
         Blob((-.04, .5, -.3), (.12, .1, .12), 'bruise'),
         Blob((0, .35, .16), (.24, .22, .26), 'bile', SAC, 1., glow=.75),
         Blob((.08, .42, .24), (.08, .07, .08), 'pus', SAC, 1., .3, glow=1., lod2=False),
         Blob((-.1, .3, .22), (.06, .05, .06), 'pus', SAC, 1., .6, glow=1., lod2=False),
         Tube([(0, .5, .05, .08), (0, .7, .2, .06), (0, .82, .3, .05)], 'flesh', HEAD, (0, .5, 1)),
         Blob((0, .84, .38), (.09, .075, .14), 'flesh', HEAD, 1.),
         Blob((0, .8, .48), (.05, .04, .05), 'gum', HEAD, 1.)]
    # sac veins: sinew laid over the sac along its meridians (they ride the pulse)
    c, r = (0, .35, .16), (.245, .225, .265)
    for k in range(5):
        phi = -1.3 + k * .65
        pts = []
        for j in range(5):
            th = .35 + j * .55
            pts.append((c[0] + r[0] * math.sin(th) * math.sin(phi), c[1] + r[1] * math.cos(th), c[2] + r[2] * math.sin(th) * math.cos(phi), .014))
        P.append(Tube(pts, 'sinew', SAC, (1,), lod2=False))
    # three mouth petals: up, lower left, lower right
    for ph, (dx, dy) in ((.25, (0, 1)), (0., (-1, -.6)), (.5, (1, -.6))):
        P.append(Tube([(dx * .03, .82 + dy * .025, .45, .03), (dx * .06, .82 + dy * .06, .55, .015), (dx * .05, .82 + dy * .05, .62, .004)], 'sinew', JAW, (.3, 1, 1), ph))
    for k in range(4):
        P.append(Tube([(0, .62 + k * .055, .1 + k * .06, .02), (0, .68 + k * .055, .06 + k * .06, .004)], 'bone', SPINE, (0, 1), k * .2, lod2=False))
    for s in (-1, 1):
        for k in range(2):
            z = -.3 if k == 0 else .05
            ph = ((k + (1 if s > 0 else 0)) % 2) * .5
            P.append(Tube([(s * .14, .4, z, .045), (s * .34, .37, z + .05, .032)], 'fleshdark', LEG, (0, .55), ph))
            P.append(Tube([(s * .34, .37, z + .05, .03), (s * .4, .08, z + .12, .014), (s * .41, 0, z + .14, .004)], 'bone', LEG, (.55, 1, 1), ph))
    return P


def mauler():
    """A hunched brute: a slab of torso armoured with bone plates, a sunken head with tusks and pin eyes, columns for
    legs and two long forearms ending in clubs of fused knuckle-bone."""
    P = [Blob((0, .62, .02), (.38, .32, .3), 'flesh'),
         Blob((0, .5, .12), (.28, .2, .2), 'fleshdark'),
         Blob((.02, .84, -.08), (.32, .2, .24), 'bruise'),
         Blob((-.2, .74, -.14), (.12, .11, .1), 'rot'),
         Blob((0, .66, .3), (.1, .09, .1), 'fleshdark', HEAD, 1.),
         Blob((0, .6, .36), (.06, .03, .05), 'gum', JAW, 1., .75)]
    for s in (-1, 1):
        ph = 0. if s > 0 else .5
        P.append(Tube([(s * .18, .42, -.03, .15), (s * .2, .2, 0, .13), (s * .18, .04, -.03, .12)], 'fleshdark', LEG, (0, .5, 1), ph))
        P.append(Blob((s * .18, .045, .03), (.12, .05, .15), 'bone', LEG, 1., ph))
        for d in (-1, 1):
            P.append(Tube([(s * .18 + d * .06, .04, .14, .03), (s * .18 + d * .08, .01, .22, .006)], 'bone', LEG, (1,), ph, lod2=False))
        P.append(Tube([(s * .05, .62, .37, .03), (s * .1, .57, .45, .016), (s * .08, .62, .51, .004)], 'bone', JAW, (.5, 1, 1), .5 if s > 0 else 0.))
        P.append(Blob((s * .045, .7, .39), (.016, .016, .012), 'eye', HEAD, 1., glow=1., lod2=False))
        # shoulder mass (body) and the arm (pivot (.42, .70, .02) in HordeLit / HordeRenderer)
        P.append(Blob((s * .38, .72, .02), (.14, .13, .14), 'flesh'))
        P.append(Tube([(s * .42, .7, .02, .12), (s * .47, .42, .1, .11), (s * .48, .24, .13, .09)], 'sinew', ARM, (0, .8, 1)))
        P.append(Blob((s * .48, .15, .16), (.18, .15, .19), 'bone', ARM, 1.))
        for k in range(5):   # the club is knuckles fused into one mass
            a = k * 1.26
            P.append(Blob((s * .48 + math.sin(a) * .15, .17 + math.cos(a * 1.7) * .06, .2 + math.cos(a) * .1), (.07, .06, .07), 'bone', ARM, 1., lod2=False))
        for d in (-1, 0, 1):
            P.append(Tube([(s * .48 + d * .07, .14, .3, .045), (s * .48 + d * .09, .1, .42, .004)], 'bone', ARM, (1,), lod2=d == 0))
    for k in range(5):
        a = -.9 + k * .45
        P.append(Blob((math.sin(a) * .3, .86 - abs(a) * .1, -.12 + math.cos(a) * .08), (.12, .05, .1), 'bone', lod2=k % 2 == 0))
    for k in range(3):
        P.append(Tube([(-.1 + k * .1, .95, -.12, .04), (-.14 + k * .14, 1.12, -.26, .006)], 'bone', SPINE, (0, 1), k * .3))
    return P


def broodsac():
    """A lurching bladder of pale membrane on four spindly legs, the curled brood pressing dark against the skin, a
    puckered vent on top, a small blind head and strands of slime hanging underneath."""
    P = [Blob((0, .56, 0), (.38, .34, .4), 'membrane', SAC, 1., glow=.22),
         Blob((0, .88, -.05), (.07, .04, .07), 'gum', JAW, 1., .25),
         Blob((0, .4, .32), (.1, .08, .1), 'fleshdark', HEAD, 1.),
         Blob((0, .36, .4), (.05, .03, .04), 'gum', JAW, 1., .75)]
    for s in (-1, 1): P.append(Blob((s * .045, .43, .4), (.018, .018, .014), 'eye', HEAD, 1., glow=1., lod2=False))
    c, r = (0, .56, 0), (.38, .34, .4)
    for k in range(7):
        a, b = k * 1.05 + .4, .55 + (k % 3) * .5
        d = (math.sin(b) * math.sin(a), math.cos(b), math.sin(b) * math.cos(a))
        p = (c[0] + r[0] * .86 * d[0], c[1] + r[1] * .86 * d[1], c[2] + r[2] * .86 * d[2])
        P.append(Blob(p, (.1, .085, .1), 'biledark', SAC, 1., k / 7, lod2=k % 2 == 0))
        q = (p[0] + d[0] * .06 + .04, p[1] + d[1] * .06, p[2] + d[2] * .06)
        P.append(Tube([p + (.03,), q + (.012,)], 'bruise', SAC, (1,), k / 7, lod2=False))
    for k in range(4):
        a = k * 1.57 + .3
        x, z = math.sin(a) * .16, math.cos(a) * .16
        P.append(Tube([(x, .26, z, .02), (x * 1.2, .14, z * 1.2, .01), (x * 1.1, .07, z * 1.3, .004)], 'sinew', SPINE, (0, .6, 1), k * .25, lod2=False))
    for k in range(4):
        a = .78 + k * 1.571
        hip, knee, foot = (math.sin(a) * .22, .38, math.cos(a) * .22), (math.sin(a) * .46, .44, math.cos(a) * .46), (math.sin(a) * .54, 0, math.cos(a) * .54)
        ph = k * .25
        P.append(Tube([hip + (.035,), knee + (.026,)], 'fleshdark', LEG, (0, .5), ph))
        P.append(Tube([knee + (.024,), foot + (.005,)], 'bone', LEG, (.5, 1), ph))
    return P


def colossus():
    """A walking mound of fused bodies: overlapping masses with the skulls of the absorbed half-sunk in them, stunted
    limbs still twitching out of the flanks, a glowing gaping maw ringed with teeth, ribs of bone, a crown of spines,
    and two great club arms."""
    P = [Blob((0, .52, 0), (.32, .26, .26), 'flesh'),
         Blob((.08, .74, -.04), (.28, .22, .24), 'bruise'),
         Blob((-.12, .66, .08), (.18, .16, .16), 'fleshdark'),
         Blob((.14, .58, .16), (.14, .13, .13), 'bile', glow=.3),
         Blob((-.18, .48, -.12), (.15, .14, .14), 'rot'),
         Blob((.16, .4, -.14), (.12, .12, .12), 'fleshdark'),
         Blob((0, .9, .12), (.13, .11, .12), 'flesh', HEAD, 1.),
         Blob((0, .85, .22), (.08, .07, .05), 'gum', JAW, 1., .75, glow=.45)]
    for s in (-1, 1):
        ph = 0. if s > 0 else .5
        P.append(Tube([(s * .2, .34, 0, .13), (s * .22, .17, .03, .12), (s * .2, .03, 0, .13)], 'fleshdark', LEG, (0, .5, 1), ph))
        P.append(Blob((s * .2, .04, .05), (.13, .05, .15), 'bone', LEG, 1., ph))
        # arm (pivot (.36, .82, 0))
        P.append(Blob((s * .32, .8, 0), (.14, .13, .14), 'bruise'))
        P.append(Tube([(s * .36, .82, 0, .16), (s * .42, .5, .08, .14), (s * .43, .3, .12, .12)], 'bruise', ARM, (0, .8, 1)))
        P.append(Blob((s * .43, .24, .15), (.25, .2, .26), 'bone', ARM, 1.))
        for k in range(6):
            a = k * 1.05
            P.append(Blob((s * .43 + math.sin(a) * .21, .26 + math.cos(a * 1.7) * .08, .2 + math.cos(a) * .14), (.09, .08, .09), 'bone', ARM, 1., lod2=False))
        P.append(Blob((s * .43, .3, .08), (.1, .06, .1), 'sinew', ARM, 1., lod2=False))
        for d in (-1, 0, 1):
            P.append(Tube([(s * .43 + d * .1, .22, .34, .06), (s * .43 + d * .13, .17, .5, .006)], 'bone', ARM, (1,), lod2=d == 0))
    for k in range(6):
        a = -1.1 + k * .44
        P.append(Tube([(math.sin(a) * .06, .86, .25, .012), (math.sin(a) * .07, .84 - abs(a) * .02, .29, .003)], 'bone', JAW, (1,), .75, lod2=False))
    for k in range(5):
        P.append(Tube([(-.2 + k * .1, .55, .2, .02), (-.22 + k * .11, .4, .27, .012)], 'bone', lod2=False))
    for k in range(7):
        a = -1.2 + k * .4
        P.append(Tube([(math.sin(a) * .2, .9, -.08 + math.cos(a) * .05, .035), (math.sin(a) * .36, 1.1 + (k % 2) * .06, -.2, .004)], 'bone', SPINE, (0, 1), k * .14, lod2=k % 2 == 0))
    for p in ((-.25, .45, -.22), (0, .55, -.24), (.25, .65, -.2), (-.3, .62, .05), (.28, .45, .1)):
        P.append(Blob(p, (.07, .06, .06), 'pus', SAC, 1., (p[0] + 1) % 1, glow=1., lod2=p[2] < 0))
    for p in ((-.22, .62, .2), (.27, .7, .02), (-.06, .4, .25)):
        P.append(Blob(p, (.06, .07, .06), 'bone', lod2=False))
        for s in (-1, 1): P.append(Blob((p[0] + s * .025, p[1] + .01, p[2] + .05), (.015, .018, .012), 'gum', lod2=False))
    for base, tip in (((-.3, .56, .12), (-.48, .62, .2)), ((.28, .5, -.08), (.46, .56, -.16)), ((-.2, .4, -.2), (-.32, .3, -.36))):
        mid = ((base[0] + tip[0]) * .5, (base[1] + tip[1]) * .5 + .05, (base[2] + tip[2]) * .5)
        P.append(Tube([base + (.035,), mid + (.025,), tip + (.012,)], 'fleshdark', SPINE, (0, .6, 1), (tip[0] + 1) % 1, lod2=False))
    return P


def hive():
    """A pulsing mound of rot: overlapping lobes webbed with veins, glowing pustules, a gum-lined crown around a
    glowing orifice ringed with swaying bone spines, and roots spreading into the ground."""
    P = [Blob((0, 0, 0), (.5, .42, .5), 'rot'),
         Blob((.18, .1, -.12), (.3, .38, .28), 'fleshdark'),
         Blob((-.2, .05, .14), (.28, .3, .3), 'bruise'),
         Blob((-.05, .12, -.3), (.22, .25, .2), 'fleshdark'),
         Blob((.3, 0, .2), (.2, .2, .2), 'rot'),
         Blob((.02, .38, .02), (.2, .22, .2), 'flesh'),
         Blob((.03, .54, .03), (.13, .05, .13), 'gum'),
         Blob((.03, .57, .03), (.08, .05, .08), 'pus', JAW, 1., .25, glow=1.)]
    for k in range(6):
        a = k * 1.047 + .3
        P.append(Tube([(math.sin(a) * .12, .45, math.cos(a) * .12, .04), (math.sin(a) * .2, .64, math.cos(a) * .2, .02),
                       (math.sin(a) * .26, .8 + (k % 3) * .06, math.cos(a) * .26, .004)], 'bone', SPINE, (0, .5, 1), k / 6))
    rnd = random.Random(5)
    for k in range(10):
        a, b = k * .63 + .2, .5 + (k % 4) * .28
        p = (math.sin(a) * math.sin(b) * .5, math.cos(b) * .42 + .02, math.cos(a) * math.sin(b) * .5)
        rad = .05 + rnd.random() * .04
        P.append(Blob(p, (rad, rad * .9, rad), 'pus', SAC, 1., k / 10, glow=1., lod2=k % 2 == 0))
    for k in range(7):
        a = k * .9 + .1
        pts = []
        for j in range(5):
            b = .2 + j * .32
            pts.append((math.sin(a + j * .08) * math.sin(b) * .51, math.cos(b) * .43, math.cos(a + j * .08) * math.sin(b) * .51, .018))
        P.append(Tube(pts, 'sinew', lod2=False))
    for k in range(7):
        a = k * .9 + .5
        P.append(Tube([(math.sin(a) * .4, .0, math.cos(a) * .4, .07), (math.sin(a + .1) * .62, -.01, math.cos(a + .1) * .62, .04),
                       (math.sin(a - .05) * .8, -.03, math.cos(a - .05) * .8, .012)], 'rot', lod2=k % 2 == 0))
    return P


# name: (builder, voxel size, LOD0 tris, LOD1 tris, cut below y)
CREATURES = {
    'Crawler': (crawler, .0065, 3600, 1000, None),
    'Husk': (husk, .0065, 3200, 950, None),
    'Spitter': (spitter, .007, 3600, 1000, None),
    'Mauler': (mauler, .0085, 4500, 1300, None),
    'Broodsac': (broodsac, .0075, 3600, 1000, None),
    'Colossus': (colossus, .0085, 9000, 2600, None),
    'Hive': (hive, .0095, 10000, 2800, -.04),
}


# ============================================================================================ field + sculpt
def field(parts, co, k=.014):
    """Soft nearest-part blend at a point: region, phase, weight, colour, glow, sculpt detail, distance."""
    x, y, z = co
    ds = []
    dmin = 1e9
    for p in parts:
        d, t = p.sd(x, y, z)
        ds.append((d, t))
        if d < dmin: dmin = d
    reg_w = [0.] * 7; reg_ws = [0.] * 7; reg_best = [1e9] * 7; reg_phase = [0.] * 7
    tot = r = g = b = glow = det = 0.
    for p, (d, t) in zip(parts, ds):
        e = d - dmin
        if e > 6 * k: continue
        s = math.exp(-e / k)
        tot += s
        r += s * p.rgb[0]; g += s * p.rgb[1]; b += s * p.rgb[2]
        glow += s * p.glow; det += s * p.detail
        reg_w[p.region] += s
        reg_ws[p.region] += s * p.weight(t)
        if d < reg_best[p.region]: reg_best[p.region], reg_phase[p.region] = d, p.phase
    region = max(range(7), key=lambda i: reg_w[i])
    weight = 0. if region == BODY else reg_ws[region] / tot
    nearest = parts[min(range(len(parts)), key=lambda i: ds[i][0])]
    return region, reg_phase[region], weight, (r / tot, g / tot, b / tot), glow / tot, det / tot, nearest


def offset(seed):
    return Vector((seed * 1.7, seed * 3.1, seed * .7))


def tumour_at(p):
    """Clustered growths: bright where a point sits near a Voronoi feature point (shared by sculpt and colour)."""
    dist, _ = noise.voronoi(p * 9., distance_metric='DISTANCE', exponent=2.5)
    return max(0., 1. - dist[0] * 3.) ** 2


def sculpt(bm, parts, seed):
    """Displace the fused surface along its normal: broad lumps, tumour clusters (Voronoi cells) and wrinkle creases."""
    off = offset(seed)
    bm.normal_update()
    moves = []
    for v in bm.verts:
        _, _, _, _, _, det, nearest = field(parts, v.co, .02)
        if det <= 0.01: moves.append(None); continue
        p = v.co + off
        lump = noise.fractal(p * 5.5, 1.0, 2.0, 3, noise_basis='PERLIN_ORIGINAL')
        tumour = tumour_at(p)
        ridge = 1. - abs(noise.noise(p * 30., noise_basis='PERLIN_ORIGINAL'))
        crease = ridge ** 8
        fleshy = 1. if nearest.col in FLESHY else .5
        moves.append(v.normal * det * (lump * .016 + tumour * .03 * fleshy - crease * .008))
    for v, m in zip(bm.verts, moves):
        if m is not None: v.co += m


def mesh_object(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def evaluated_bmesh(ob):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bm = bmesh.new(); bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    return bm


def decimate(bm, target, name):
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for _ in range(3):
        if len(bm.faces) <= target * 1.06: break
        ob = mesh_object(name, bm)
        mod = ob.modifiers.new('decimate', 'DECIMATE')
        mod.ratio = target / len(bm.faces)
        mod.use_collapse_triangulate = True
        bm.free()
        bm = evaluated_bmesh(ob)
        bpy.data.objects.remove(ob)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
    return bm


def lod0(name, parts, voxel, target, cut, seed):
    src = bmesh.new()
    for p in parts:
        if isinstance(p, Blob): p.build(src, 28, 16)
        else: p.build(src, 16, True)
    ob = mesh_object(name + '_src', src)
    src.free()
    mod = ob.modifiers.new('remesh', 'REMESH')
    mod.mode = 'VOXEL'; mod.voxel_size = voxel; mod.adaptivity = 0.
    bm = evaluated_bmesh(ob)
    bpy.data.objects.remove(ob)
    if cut is not None:
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, cut), plane_no=(0, 0, 1), clear_inner=True)
    bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    dense = len(bm.faces)
    sculpt(bm, parts, seed)
    bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=.25, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm = decimate(bm, target, name)
    print('[se]   %s remesh %d faces -> %d tris' % (name, dense, len(bm.faces)))
    return bm


def lod2(parts):
    bm = bmesh.new()
    for p in parts:
        if not p.lod2: continue
        if isinstance(p, Blob): p.build(bm, 6, 4)
        else: p.build(bm, 3, False)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    return bm


# ============================================================================================ bake + export
def bake_export(bm, parts, path, seed, ao_rays=16, ao_radius=.14):
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table(); bm.verts.index_update()
    bm.normal_update()
    bvh = BVHTree.FromBMesh(bm)
    rnd = random.Random(11)
    dirs = []
    for k in range(ao_rays):
        u1, u2 = (k + rnd.random()) / ao_rays, rnd.random()
        rr, phi = math.sqrt(u1), 2 * math.pi * u2
        dirs.append(Vector((rr * math.cos(phi), rr * math.sin(phi), math.sqrt(max(0., 1 - u1)))))
    off = offset(seed)
    verts = []
    for v in bm.verts:
        n = v.normal if v.normal.length > 0 else Vector((0, 0, 1))
        region, phase, weight, rgb, glow, det, nearest = field(parts, v.co)
        # ambient occlusion: cosine-weighted rays about the normal
        basis = Vector((0, 0, 1)).rotation_difference(n)
        hit = 0.
        for d in dirs:
            loc, _, _, dist = bvh.ray_cast(v.co + n * .002, basis @ d, ao_radius)
            if loc is not None and dist > .004: hit += 1 - dist / ao_radius
        ao = hit / ao_rays
        p = v.co + off
        # mottling, dark wet veins in the flesh, pale tumour tops, grime toward the ground
        mott = .82 + .3 * (noise.fractal(p * 9., 1., 2., 3, noise_basis='PERLIN_ORIGINAL') * .5 + .5)
        col = [c * mott for c in rgb]
        if nearest.col in FLESHY:
            vein = (1. - abs(noise.noise(p * 16., noise_basis='PERLIN_ORIGINAL'))) ** 14
            col = [c + (s - c) * vein * .75 for c, s in zip(col, COL['sinew'])]

            tumour = tumour_at(p)
            col = [c + (s - c) * tumour * .45 for c, s in zip(col, COL['pus'])]
            bruise = max(0., noise.noise(p * 4. + Vector((7, 1, 3)), noise_basis='PERLIN_ORIGINAL')) * .6
            col = [c + (s - c) * bruise for c, s in zip(col, COL['bruise'])]
            sore = noise.noise(p * 7. + Vector((3, 9, 4)), noise_basis='PERLIN_ORIGINAL')
            sore = min(1., max(0., (sore - .38) * 5.))     # open, wet sores
            col = [c + (s - c) * sore * .85 for c, s in zip(col, COL['gum'])]
        grime = max(0., 1. - v.co.z / .12) * .45
        col = [c + (s - c) * grime for c, s in zip(col, (.16, .14, .1))]
        shade = 1. - min(.85, ao * .75)
        if glow > .05: shade = max(shade, .8)       # glowing parts stay bright in the folds
        c8 = tuple(max(0, min(255, int(round(c * shade * 255)))) for c in col)
        a8 = max(0, min(255, int(round(255 * (1. - glow)))))
        verts.append((v.co, n, c8 + (a8,), region + min(.98, max(0., phase)), max(0., min(1., weight))))
    index = []
    for f in bm.faces:
        index.extend(v.index for v in f.verts)
    with open(path, 'wb') as fh:
        fh.write(b'SEM1'); fh.write(struct.pack('<II', len(verts), len(index)))
        for co, _, _, _, _ in verts: fh.write(struct.pack('<3f', co.x, co.z, co.y))
        for _, n, _, _, _ in verts: fh.write(struct.pack('<3f', n.x, n.z, n.y))
        for _, _, c, _, _ in verts: fh.write(struct.pack('<4B', *c))
        for _ in verts: fh.write(struct.pack('<f', 0.))
        for _, _, _, rp, w in verts: fh.write(struct.pack('<2f', rp, w))
        fh.write(struct.pack('<%dI' % len(index), *index))
    return len(verts), len(index) // 3


bpy.ops.wm.read_factory_settings(use_empty=True)
built = []
for name, (fn, voxel, t0, t1, cut) in CREATURES.items():
    if ONLY and name not in ONLY: continue
    parts = fn()
    seed = sum(map(ord, name)) % 97
    bm0 = lod0(name, parts, voxel, t0, cut, seed)
    bm1 = bm0.copy()
    bm1 = decimate(bm1, t1, name + '1')
    bm2 = lod2(parts)
    if cut is not None:
        bmesh.ops.bisect_plane(bm2, geom=bm2.verts[:] + bm2.edges[:] + bm2.faces[:], plane_co=(0, 0, cut), plane_no=(0, 0, 1), clear_inner=True)
    for lod, bm in enumerate((bm0, bm1, bm2)):
        fname = 'Horde_%s%d' % (name, lod)
        v, t = bake_export(bm, parts, os.path.join(OUT, fname + '.bytes'), seed, ao_rays=16 if lod < 2 else 8)
        built.append((fname, v, t))
        print('[se] %-18s %6d verts %6d tris' % (fname, v, t))
        bm.free()
with open(os.path.join(OUT, 'HORDE_MANIFEST.txt'), 'w') as fh:
    fh.write('Built by tools/blender/build_horde.py (name vertices triangles)\n')
    for n, v, t in built: fh.write('%s %d %d\n' % (n, v, t))
print('[se] wrote %d horde models to %s' % (len(built), OUT))
