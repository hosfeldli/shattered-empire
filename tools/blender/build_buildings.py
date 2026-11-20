# Shattered Empires — every gameplay building, with destruction stages and LODs (se_buildkit).
#   headless:  "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_buildings.py -- <models dir> [names...]
# Frame: x right, +Y = the building's front (Unity +Z; it faces the headquarters), Z up, map units; a base parcel is
# about 1.0 x 0.9 and a storey 0.12. The client mirrors layout x (a recipe's +lx is the model's -X).
#
# Writes, per building key K (the layout type the client draws):
#   Bld_K_s0 .. Bld_K_s3   intact / damaged / heavily damaged / destroyed (SEM1, rigid)
#   Bld_K_sN_lo            a lower level of detail where the stage mesh is heavy (> LOD_TRIS triangles)
#   BuildingLayout.txt     layout records for every key (format of BaseLayout.txt plus roof / accent / band / beacon,
#                          and an "@N" suffix: drawn while the stage is <= N)
#   tools/blender/BuildingStats.txt   triangle counts per building, stage and LOD
# Collision walls are copied unchanged from the previous models (BaseLayout / DefenseLayout) or, for the four
# facilities that were module recipes, from the rectangles the client recorded for them (server/sim/actionFootprints.json
# for the airfield and missile silo), so no collision footprint changes.
import bpy, sys, os, math, importlib, time
HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else r"D:/Projects/shattered_empires/tools/blender"
sys.path.insert(0, HERE)
import se_meshkit; importlib.reload(se_meshkit)
import se_buildkit; importlib.reload(se_buildkit)
from se_meshkit import PAL, CONCRETE, BRICK, SHEET, ASPHALT, FABRIC, PLAIN, GLASS, SOIL, ARMOR, ROCK
from se_buildkit import Rec, realize, blasts_for, finalize_palette

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = SE_OUT if 'SE_OUT' in globals() else (args[0] if args else os.path.join(os.getcwd(), 'out'))
ONLY = set(args[1:])
os.makedirs(OUT, exist_ok=True)
LOD_TRIS = 2600

PAL.update({
    'concrete': ((.74, .72, .66), CONCRETE), 'concrete2': ((.60, .60, .56), CONCRETE), 'concrete3': ((.82, .81, .76), CONCRETE),
    'brick': ((.66, .56, .46), BRICK), 'brickr': ((.62, .42, .34), BRICK),
    'roofm': ((.60, .63, .61), SHEET), 'roofl': ((.72, .72, .69), CONCRETE), 'siding': ((.60, .63, .60), SHEET),
    'sidingd': ((.42, .45, .44), SHEET), 'tarmac': ((.34, .35, .34), ASPHALT), 'window': ((.30, .42, .48), GLASS),
    'glassb': ((.40, .58, .66), GLASS),
    'sandbag': ((.64, .58, .45), FABRIC), 'sandbag2': ((.58, .53, .41), FABRIC), 'gabion': ((.56, .52, .42), FABRIC),
    'olive2': ((.40, .44, .32), PLAIN), 'olive': ((.47, .51, .38), ARMOR), 'hazard': ((.86, .66, .16), PLAIN),
    'rust': ((.55, .37, .26), SHEET), 'crate': ((.50, .38, .24), PLAIN), 'earth': ((.50, .43, .32), SOIL),
    'timber': ((.52, .40, .27), PLAIN), 'gun': ((.30, .31, .30), ARMOR), 'slit': ((.08, .08, .08), PLAIN),
    'white': ((.92, .92, .89), PLAIN), 'stripe': ((.94, .93, .88), PLAIN), 'ore': ((.46, .36, .28), SOIL), 'coal': ((.20, .19, .18), SOIL),
    'grass': ((.40, .47, .30), SOIL),
    # per-type roof families, so the halls read apart by colour as well as shape
    'roof_bar': ((.44, .50, .36), SHEET),      # barracks: olive-green corrugated gables
    'roof_veh': ((.46, .54, .62), SHEET),      # vehicle works: blue-grey sawtooth
    'roof_hvy': ((.62, .38, .30), SHEET),      # heavy weapons: oxide red
    'roof_air': ((.78, .79, .77), SHEET),      # airfield: pale arched hangars
    'roof_gen': ((.36, .38, .38), SHEET),      # generator: dark
    'roof_dep': ((.66, .50, .32), SHEET),      # processor: ochre
    'roof_lab': ((.86, .87, .86), CONCRETE),   # lab: white
    'crane': ((.88, .62, .14), PLAIN),
    # roof emblems: a dark bevelled rim, the facility's accent (FacilityAccent, toned down) and a white sign
    'emb_rim': ((.22, .23, .23), PLAIN), 'emb_ink': ((.95, .94, .90), PLAIN),
    'acc_barracks': ((.42, .72, .36), PLAIN), 'acc_motor_works': ((.32, .52, .86), PLAIN), 'acc_heavy_weapons': ((.84, .30, .25), PLAIN),
    'acc_airfield': ((.58, .80, .90), PLAIN), 'acc_power_plant': ((.92, .78, .22), PLAIN), 'acc_depot': ((.92, .56, .20), PLAIN),
    'acc_advanced_lab': ((.26, .80, .70), PLAIN), 'acc_missile_silo': ((.86, .34, .66), PLAIN),
})
finalize_palette()

BUILT = []

# ------------------------------------------------------------------ helpers (all on a Rec)
def rounded_outline(cx, cy, w, d, r, n=4):
    pts = []
    for (sx, sy, a0) in ((1, -1, -90), (1, 1, 0), (-1, 1, 90), (-1, -1, 180)):
        ox, oy = cx + sx * (w / 2 - r), cy + sy * (d / 2 - r)
        for k in range(n + 1):
            ang = math.radians(a0 + 90 * k / n)
            pts.append((ox + math.cos(ang) * r, oy + math.sin(ang) * r))
    return pts

def polygon(cx, cy, r, n, phase=0.):
    return [(cx + math.sin(phase + k * math.tau / n) * r, cy + math.cos(phase + k * math.tau / n) * r) for k in range(n)]

def plinth(a, cx, cy, w, d):
    a.prism(rounded_outline(cx, cy, w, d, .09), 'z', -.13, .01, 'concrete2', bevel=.008, role='ground')

def pad(a, cx, cy, w, d, key='tarmac'):
    a.box((cx, cy, .013), (w, d, .006), key, bevel=0, role='ground')

def windows(a, cx, cy, w, d, z0, floors, storey, n, sides=('front', 'back'), key='window'):
    for f in range(floors):
        z = z0 + storey * (f + .55)
        for k in range(n):
            x = cx - w / 2 + (k + .5) * w / n
            if 'front' in sides: a.box((x, cy + d / 2 + .003, z), (w / n * .55, .006, storey * .42), key, bevel=0)
            if 'back' in sides: a.box((x, cy - d / 2 - .003, z), (w / n * .55, .006, storey * .42), key, bevel=0)

def side_windows(a, cx, cy, w, d, z0, floors, storey, n, sides=('left', 'right'), key='window'):
    for f in range(floors):
        z = z0 + storey * (f + .55)
        for k in range(n):
            y = cy - d / 2 + (k + .5) * d / n
            if 'right' in sides: a.box((cx + w / 2 + .003, y, z), (.006, d / n * .55, storey * .42), key, bevel=0)
            if 'left' in sides: a.box((cx - w / 2 - .003, y, z), (.006, d / n * .55, storey * .42), key, bevel=0)

def gable_x(a, x0, x1, cy, depth, zeave, ridge, key, oh=.02):
    """A pitched roof whose ridge runs along x."""
    a.prism([(cy - depth / 2 - oh, zeave), (cy + depth / 2 + oh, zeave), (cy, ridge)], 'x', x0 - oh, x1 + oh, key, bevel=.003)

def gable_y(a, y0, y1, cx, width, zeave, ridge, key, oh=.02):
    a.prism([(cx - width / 2 - oh, zeave), (cx + width / 2 + oh, zeave), (cx, ridge)], 'y', y0 - oh, y1 + oh, key, bevel=.003)

def parapet_roof(a, cx, cy, w, d, z, key='roofl', lip='concrete2'):
    a.box((cx, cy, z + .006), (w - .01, d - .01, .012), key, bevel=0)
    for s in (-1, 1):
        a.box((cx, cy + s * (d / 2 - .006), z + .018), (w, .012, .024), lip, bevel=.002)
        a.box((cx + s * (w / 2 - .006), cy, z + .018), (.012, d, .024), lip, bevel=.002)

def roller_door(a, x, y, w, h, frame='hazard'):
    a.box((x, y + .004, h / 2 + .01), (w, .008, h), 'sidingd', bevel=0)
    for r in range(int(h / .028)): a.box((x, y + .009, .02 + r * .028), (w, .004, .004), 'siding', bevel=0)
    for s in (-1, 1): a.box((x + s * (w / 2 + .008), y + .006, h / 2 + .01), (.014, .012, h + .02), frame, bevel=0)
    a.box((x, y + .008, h + .025), (w + .03, .014, .016), frame, bevel=0)

def hvac(a, x, y, z):
    a.box((x, y, z + .025), (.09, .07, .05), 'siding', bevel=.005)
    a.cyl((x, y, z + .05), 'z', .025, .025, .006, 'grille', segs=12, bevel=0)

def floodlight(a, x, y, h=.42):
    a.cyl((x, y, 0), 'z', .01, .008, h, 'steel', segs=8, bevel=0)
    a.box((x, y + .015, h), (.06, .025, .03), 'dark', bevel=.004)
    a.box((x, y + .029, h), (.05, .003, .022), 'lamp', bevel=0)

def lattice_mast(a, x, y, z0, h, w=.05):
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((x + sx * w / 2, y + sy * w / 2, z0), (x + sx * w * .2, y + sy * w * .2, z0 + h), .0035, 'steel')
    for k in range(int(h / .07)):
        z = z0 + k * .07; s = w / 2 * (1 - .6 * k * .07 / h)
        a.beam((x - s, y - s, z), (x + s, y + s, z + .07), .002, 'steel'); a.beam((x + s, y - s, z), (x - s, y + s, z + .07), .002, 'steel')
    a.beam((x, y, z0 + h), (x, y, z0 + h + .12), .0025, 'dark')

def sandbags(a, x, y, length, along_x=True, rows=3):
    for r in range(rows):
        n = int(length / .05)
        for k in range(n):
            off = -length / 2 + (k + .5 + (r % 2) * .5) * length / n
            px, py = (x + off, y) if along_x else (x, y + off)
            a.box((px, py, .012 + r * .022), (.048 if along_x else .03, .03 if along_x else .048, .022), 'sandbag', bevel=.006)

def hesco(a, x, y, n, along_x=True):
    for k in range(n):
        px, py = (x + k * .085, y) if along_x else (x, y + k * .085)
        a.box((px, py, .045), (.08, .08, .09), 'gabion', bevel=.006)

def silo(a, x, y, r, h, key='concrete3', cone=.06, segs=18):
    a.lathe([(0, 0), (r, 0), (r, h), (r * .25, h + cone), (0, h + cone)], 'z', key, segs=segs, center=(x, y, 0))

def hyperboloid(a, x, y, r, h, key='concrete3'):
    """A cooling tower: hyperbolic shell, open throat, dark interior at the top."""
    prof = [(0, 0), (r, 0), (r, .02)]
    for k in range(1, 7):
        t = k / 6
        prof.append((r * (1 - .36 * math.sin(t * math.pi * .72)), .02 + (h - .02) * t))
    top = prof[-1][0]
    prof += [(top * .86, h), (top * .78, h * .82), (0, h * .82)]
    a.lathe(prof, 'z', key, segs=22, center=(x, y, 0))
    a.cyl((x, y, h * .82 + .002), 'z', top * .78, top * .78, .004, 'coal', segs=16, bevel=0)

def conveyor(a, p0, p1, legs=3):
    a.beam(p0, p1, .016, 'sidingd', segs=4)
    a.beam((p0[0], p0[1], p0[2] + .022), (p1[0], p1[1], p1[2] + .022), .004, 'hazard', segs=4)
    for k in range(1, legs + 1):
        t = k / (legs + 1)
        x, y, z = (p0[i] + (p1[i] - p0[i]) * t for i in range(3))
        a.beam((x, y, 0), (x, y, z - .012), .005, 'steel', segs=4)

def dish(a, x, y, z, r, aim=(0, -.4, 1)):
    a.cyl((x, y, z - .05), 'z', .012, .012, .05, 'steel', segs=8, bevel=0)
    a.cyl((x, y, z), aim, r, r * .18, r * .45, 'concrete3', segs=18, bevel=0)

def tank(a, x, y, yaw):
    """A main battle tank on show (the vehicle works' product)."""
    s, c = math.sin(yaw), math.cos(yaw)
    def P(u, v): return (x + u * c + v * s, y - u * s + v * c)
    for side in (-1, 1):
        px, py = P(side * .062, 0)
        a.obox(px, py, .012, .052, .034, .21, yaw, 'gun', bevel=.006)
    px, py = P(0, 0)
    a.obox(px, py, .03, .075, .11, .2, yaw, 'olive', bevel=.006)
    tx, ty = P(0, -.02)
    a.cyl((tx, ty, .075), 'z', .045, .04, .035, 'olive', segs=12, bevel=0)
    bx, by = P(0, .02)
    a.cyl((bx, by, .093), (s, c, .02), .007, .006, .16, 'gun', segs=6, bevel=0)

def jet(a, x, y, yaw, key='siding'):
    s, c = math.sin(yaw), math.cos(yaw)
    def P(u, v): return (x + u * c + v * s, y - u * s + v * c)
    nx, ny = P(0, .13); tx, ty = P(0, -.13)
    a.beam((tx, ty, .04), (nx, ny, .04), .02, key, segs=8)
    a.cyl((nx, ny, .04), (s, c, 0), .02, .002, .05, key, segs=8, bevel=0)
    w = [P(-.13, -.06), P(0, .07), P(.13, -.06), P(0, -.03)]
    a.prism(w, 'z', .036, .044, key, bevel=0)
    tl = [P(-.06, -.14), P(0, -.09), P(.06, -.14)]
    a.prism(tl, 'z', .04, .046, key, bevel=0)
    fx, fy = P(0, -.12)
    a.obox(fx, fy, .045, .1, .008, .06, yaw, key, bevel=0)
    cx_, cy_ = P(0, .06)
    a.obox(cx_, cy_, .05, .068, .022, .06, yaw, 'glassb', bevel=0)

# The type signs (as the client's old roof emblems drew them): bars (ox, oy, angle, width, length) in plate units, oy up.
_T, _D, _A = .13, .785, 1.5708
SIGNS = {
    'barracks': [(0, 0, _D, _T, .8), (0, 0, -_D, _T, .8)],                                                   # crossed rifles
    'motor_works': [(0, .18, _A, _T, .66), (0, -.18, _A, _T, .66), (-.3, 0, 0, _T, .48), (.3, 0, 0, _T, .48)],  # a track
    'heavy_weapons': [(0, .1, _D, .26, .26), (0, -.2, _A, _T, .62)],                                        # a shell on a barrel
    'airfield': [(0, 0, 0, _T, .76), (0, .08, _A, _T, .78), (0, -.28, _A, _T, .34)],                         # an aircraft
    'power_plant': [(.08, .17, -.5, _T, .38), (0, 0, 1.2, _T, .32), (-.08, -.17, -.5, _T, .38)],             # a bolt
    'depot': [(0, .25, _A, _T, .62), (0, -.25, _A, _T, .62), (-.25, 0, 0, _T, .62), (.25, 0, 0, _T, .62), (0, 0, _D, _T * .8, .66)],
    'advanced_lab': [(math.sin(k * math.pi / 4) * .29, math.cos(k * math.pi / 4) * .29, k * math.pi / 4 + math.pi / 2, _T * .9, .25) for k in range(8)]
                    + [(0, 0, _D, .15, .15)],                                                              # an orbit
    'missile_silo': [(0, -.08, 0, _T, .62), (-.1, .14, -_D, _T, .34), (.1, .14, _D, _T, .34)],              # an arrow
}

def emblem(a, cx, cy, z, size, tilt=0.):
    """The facility's roof emblem, part of the model: a bevelled dark rim, the accent plate and the raised white sign, lying
    on the roof at (cx, cy) whose top is z (tilt: the roof's pitch about x; positive lifts the front edge). It turns with the
    building, survives the damaged stages (scorched at stage 2) and goes with the ruin. The SEM1 export mirrors x, so the
    sign is laid out mirrored here and reads the right way round in game; its top points to the building's back."""
    t = a.t
    cos_t, sin_t = math.cos(tilt), math.sin(tilt)
    def P(u, v, h):   # plate frame (u right, v toward the back, h up off the roof) to model space
        y, zz = -v, h
        return (cx + u, cy + y * cos_t - zz * sin_t, z + y * sin_t + zz * cos_t)
    rim = size + .026
    a.rbox(P(0, 0, .0035), (rim, rim, .007), (tilt, 0, 0), 'emb_rim', role='emblem')
    a.rbox(P(0, 0, .0085), (rim - .014, rim - .014, .004), (tilt, 0, 0), 'emb_rim', role='emblem')    # bevel step
    a.rbox(P(0, 0, .0095), (size, size, .006), (tilt, 0, 0), 'acc_' + t, role='emblem')
    for (ox, oy, ang, w, h) in SIGNS[t]:
        u, v = -ox * size, oy * size                     # mirrored across u (see above)
        a.rbox(P(u, v, .0135), (w * size, h * size, .003), (tilt, 0, -ang), 'emb_ink', role='emblem', order='ZXY')
    a.protect.append((cx, cy, z, rim * .5 + .01))

def finish(r):
    BUILT.append(r)
    return r

# ================================================================== base facilities
def headquarters(tier):
    """The command hub: a stepped drum on its podium (the base presentation docks its gates to the drum). The tiers grow
    upward: tier 1 a squat drum and a short command tower; tier 2 a full tower, radome turrets and a dish; tier 3 a
    raised upper drum, four bastion towers, a tall crowned spire and an antenna farm."""
    t = 'town' if tier == 1 else 'town_t%d' % tier
    a = Rec('Bld_' + t, t, seed=4100 + tier)
    a.lathe([(0, -.08), (.66, -.08), (.66, .018), (.635, .036), (0, .036)], 'z', 'concrete2', segs=32, role='ground')
    a.ring(.55, .60, .036, .05, 'sidingd', segs=32, role='ground')
    a.lathe([(0, .03), (.50, .03), (.50, .225), (.475, .24), (0, .24)], 'z', 'concrete', segs=28)
    a.ring(.495, .508, .095, .165, 'window', segs=28, role='glass')
    for z in (.09, .17): a.ring(.49, .516, z, z + .008, 'concrete2', segs=28, role='detail')
    for k in range(16):
        ang = (k + .5) * math.tau / 16
        a.obox(math.sin(ang) * .505, math.cos(ang) * .505, .03, .23, .026, .03, ang, 'concrete2', bevel=.003, role='detail')
    up = {1: .32, 2: .35, 3: .45}[tier]
    a.lathe([(0, .235), (.37, .235), (.37, up), (0, up)], 'z', 'concrete', segs=24)
    a.ring(.372, .378, .26, up - .02, 'window', segs=24, role='glass')
    a.ring(.35, .392, up - .005, up + .025, 'concrete2', segs=24, role='detail')
    a.cyl((0, 0, up - .005), 'z', .352, .352, .012, 'roofl', segs=24, bevel=0, role='detail')
    if tier == 1:
        cab0, cab1 = .48, .56
        a.lathe([(0, up), (.14, up), (.14, cab0), (0, cab0)], 'z', 'concrete', segs=20)
    else:
        cab0 = {2: .55, 3: .70}[tier]; cab1 = cab0 + .10
        a.lathe([(0, up), (.15, up), (.15, cab0), (0, cab0)], 'z', 'concrete', segs=20)
        for k in range(4):   # tower ribs
            ang = k * math.tau / 4 + math.tau / 8
            a.obox(math.sin(ang) * .15, math.cos(ang) * .15, up, cab0, .03, .03, ang, 'concrete2', bevel=.002)
    a.lathe([(0, cab0), (.17, cab0), (.205, cab0 + .05), (.185, cab1 - .005), (0, cab1 - .005)], 'z', 'window', segs=20, role='glass')
    a.lathe([(0, cab1 - .005), (.215, cab1 - .005), (.215, cab1 + .017), (.06, cab1 + .035), (0, cab1 + .035)], 'z', 'roofl', segs=20)
    for k in range(10):
        ang = k * math.tau / 10
        a.beam((math.sin(ang) * .172, math.cos(ang) * .172, cab0 + .002), (math.sin(ang) * .205, math.cos(ang) * .205, cab0 + .05), .004, 'concrete2')
        a.beam((math.sin(ang) * .205, math.cos(ang) * .205, cab0 + .05), (math.sin(ang) * .186, math.cos(ang) * .186, cab1 - .007), .004, 'concrete2')
    mast_h = {1: .22, 2: .28, 3: .36}[tier]
    lattice_mast(a, 0, 0, cab1 + .035, mast_h, w=.045)
    a.beacon(0, 0, cab1 + .035 + mast_h + .12, .03, 1.4)
    for k in range(4):   # roof plant on the upper drum
        ang = k * math.tau / 4 + math.tau / 8
        x, y = math.sin(ang) * .27, math.cos(ang) * .27
        a.box((x, y, up + .03), (.08, .06, .045), 'siding', bevel=.004)
    for s in (-1, 1): floodlight(a, s * .58, -.25, .30)
    if tier >= 2:
        for k in range(4):   # radome turrets on the lower drum roof
            ang = k * math.pi * .5
            x, y = math.sin(ang) * .43, math.cos(ang) * .43
            a.cyl((x, y, .24), 'z', .045, .045, .04, 'concrete2', segs=14, bevel=0)
            a.ellipsoid((x, y, .29), (.05, .05, .045), 'concrete3', segs=14, rings=7)
        dish(a, -.22, -.2, up + .1, .085)
    if tier >= 3:
        for k in range(4):   # bastion towers between the gates
            ang = k * math.pi * .5 + math.pi * .25
            x, y = math.sin(ang) * .44, math.cos(ang) * .44
            a.prism(polygon(x, y, .065, 6, math.pi / 6), 'z', .03, .50, 'concrete', bevel=.004)
            a.prism(polygon(x, y, .075, 6, math.pi / 6), 'z', .50, .53, 'concrete2', bevel=.003)
            a.cyl((x, y, .53), 'z', .006, .006, .12, 'steel', segs=6, bevel=0)
            a.beacon(x, y, .655, .022, .9)
        for k in range(3): a.cyl((-.2 + k * .07, .24, up + .02), 'z', .007, .007, .24 + k * .06, 'steel', segs=6, bevel=0)
        dish(a, .25, .2, up + .12, .1, (.3, .4, 1))
        a.band(0, 0, .218, cab0 + .102, .016, 20, 0., .5)                       # team crown on the cab
    # team bands: the lower drum (between the pilasters, over the windows) and the upper drum
    a.band(0, 0, .507, .186, .026, 16, .03, .3)
    a.band(0, 0, .377, .238, .018, 20, 0., .3)
    a.wall(0, 0, .98, .98); a.wall(0, 0, .98, .98, math.pi / 4)
    for (x, y, w, d) in ((0, .371, .2, .006), (0, -.371, .2, .006), (.371, 0, .006, .2), (-.371, 0, .006, .2)):
        a.mark(x, y, .30, w, .03, d)
    a.flag(-.42, .45, .5); a.flag(.42, .45, .5)
    a.mount(0, -.265, up + .007)
    return finish(a)

def barracks():
    """Long olive-gabled dormitory blocks either side of a taller flat-roofed command block, a mess hall turned across,
    a water tower behind and a drill yard with a tall flag in front."""
    t = 'barracks'; a = Rec('Bld_' + t, t)
    plinth(a, 0, -.08, 1.0, .9)
    for y in (-.335, -.065):                                          # the two dormitory blocks
        a.box((-.17, y, .095), (.60, .15, .19), 'brick', bevel=.006)
        a.box((-.17, y, .012), (.61, .16, .024), 'concrete2', bevel=.003, role='detail')
        gable_x(a, -.47, .13, y, .15, .19, .265, 'roof_bar')
        for side in (-1, 1): windows(a, -.17, y, .58, .15, .02, 2, .085, 9, ('front',) if side > 0 else ('back',))
        for k in range(3): a.box((-.40 + k * .23, y, .27), (.022, .022, .04), 'brick', bevel=.002)   # chimneys
    a.box((-.17, -.2, .15), (.24, .30, .30), 'concrete', bevel=.008)  # command block between them
    parapet_roof(a, -.17, -.2, .24, .30, .30)
    windows(a, -.17, -.2, .2, .30, .02, 2, .12, 3)
    a.box((-.17, -.04, .17), (.12, .05, .012), 'roof_bar', bevel=.003)  # entrance canopy
    a.box((-.17, -.048, .07), (.07, .006, .12), 'sidingd', bevel=0, role='detail')
    # the mess hall, gable across, and its kitchen flue
    a.box((.30, .02, .075), (.33, .50, .15), 'brick', bevel=.006)
    gable_y(a, -.23, .27, .30, .33, .15, .225, 'roof_bar')
    side_windows(a, .30, .02, .33, .50, .01, 1, .13, 5)
    a.cyl((.40, -.17, .15), 'z', .018, .016, .17, 'steel', segs=8, bevel=0)
    a.smoke(.40, -.17, .33, False, .22)
    # water tower behind: four legs, a drum tank, conical cap
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((.42 + sx * .04, -.43 + sy * .04, 0), (.42 + sx * .03, -.43 + sy * .03, .36), .006, 'steel', segs=6)
    a.lathe([(0, .36), (.07, .36), (.07, .46), (.03, .5), (0, .5)], 'z', 'roof_bar', segs=16, center=(.42, -.43, 0))
    # drill yard and stand, hurdles, sandbag range
    pad(a, -.16, .27, .52, .26, 'tarmac')
    for k in range(4): a.box((-.38 + k * .145, .27, .0175), (.006, .22, .003), 'stripe', bevel=0, role='ground')
    a.box((-.16, .40, .018), (.48, .006, .003), 'stripe', bevel=0, role='ground')
    for k in range(3):
        x = -.02 + k * .1
        for s in (-1, 1): a.box((x + s * .028, .22, .025), (.008, .008, .05), 'timber', bevel=0)
        a.box((x, .22, .048), (.066, .008, .008), 'timber', bevel=0)
    sandbags(a, .30, .37, .25)
    hesco(a, -.48, -.48, 3)
    floodlight(a, -.46, .14)
    a.wall(-.17, -.2, .62, .44); a.wall(.3, .02, .36, .54); a.wall(.3, .37, .26, .04)
    a.mark(-.17, -.044, .24, .12, .03, .006)
    a.flag(-.42, .37, .78)
    a.accent(-.42, .37, 0, .07, .03, .07, .4)
    emblem(a, -.17, -.2, .313, .17)
    return finish(a)

def vehicle_works():
    """A big blue-grey sawtooth hall with three wide roller doors (accent frames), an office block and a front apron
    with a proof tank on its turntable."""
    t = 'motor_works'; a = Rec('Bld_' + t, t)
    plinth(a, 0, -.08, 1.04, .9)
    a.box((-.1, -.2, .13), (.78, .58, .26), 'siding', bevel=.008)
    for k in range(10): a.box((-.49 + k * .087, .092, .13), (.012, .006, .25), 'sidingd', bevel=0, role='detail')
    for k in range(3):                                                              # sawtooth north lights, taller teeth
        y0 = -.49 + k * .116
        a.prism([(y0, .26), (y0 + .116, .26), (y0 + .116, .37)], 'x', -.49, .29, 'roof_veh', bevel=.003)
        a.box((-.1, y0 + .116 + .002, .315), (.76, .004, .1), 'glassb', bevel=0)
    a.box((-.1, -.026, .266), (.76, .232, .012), 'roofl', bevel=0)                  # the flat front deck
    a.box((-.1, .084, .278), (.78, .012, .024), 'concrete2', bevel=.002)
    for s in (-1, 1): a.box((-.1 + s * .384, -.026, .278), (.012, .232, .024), 'concrete2', bevel=.002)
    emblem(a, -.1, -.03, .273, .18)
    for bay in range(3):
        x = -.36 + bay * .26
        roller_door(a, x, .09, .2, .19)
        a.accent(x, .107, .222, .22, .018, .012, .45)
    a.box((.42, -.25, .09), (.22, .44, .18), 'brick', bevel=.008)                     # office
    parapet_roof(a, .42, -.25, .22, .44, .18)
    windows(a, .42, -.25, .22, .44, .0, 1, .17, 3); side_windows(a, .42, -.25, .22, .44, .0, 1, .17, 5, ('right',))
    hvac(a, .42, -.36, .19); hvac(a, .42, -.14, .19)
    # apron, turntable and proof tank, wash gantry, tyre stacks, fuel island
    pad(a, -.06, .30, .84, .34)
    a.cyl((.26, .31, .012), 'z', .12, .12, .008, 'concrete2', segs=24, bevel=0, role='ground')
    a.band(.26, .31, .126, .012, .009, 24, 0., .35, accent=True)
    tank(a, .26, .31, -.6)
    for s in (-1, 1):
        a.beam((-.1 + s * .09, .25, 0), (-.1 + s * .09, .25, .17), .007, 'hazard', segs=6)
        a.beam((-.1 + s * .09, .40, 0), (-.1 + s * .09, .40, .17), .007, 'hazard', segs=6)
        a.beam((-.1 + s * .09, .25, .17), (-.1 + s * .09, .40, .17), .006, 'hazard', segs=6)
    a.box((-.1, .325, .175), (.2, .17, .012), 'roof_veh', bevel=.002)
    for k in range(3):
        for j in range(3): a.cyl((-.46 + k * .06, .43, .012 + j * .022), 'z', .026, .026, .02, 'rubber', segs=12, bevel=0)
    a.box((.44, .44, .04), (.05, .03, .08), 'olive2', bevel=.004); a.box((.44, .44, .12), (.14, .08, .01), 'roof_veh', bevel=.002)
    a.wall(-.1, -.2, .8, .6); a.wall(.42, -.25, .24, .46)
    a.mark(-.1, .1, .27, .74, .02, .006)
    a.flag(-.48, .41, .37)
    return finish(a)

def heavy_weapons():
    """A tall oxide-red assembly hall under a clerestory monitor, with a big portal gantry crane on rails across the
    yard (an artillery barrel on its hook), a proof bunker and a howitzer on the test pad."""
    t = 'heavy_weapons'; a = Rec('Bld_' + t, t)
    plinth(a, 0, -.08, 1.04, .9)
    a.box((.12, -.18, .16), (.67, .46, .32), 'brickr', bevel=.008)
    gable_x(a, -.215, .455, -.18, .46, .32, .37, 'roof_hvy', oh=.015)
    a.box((.12, -.18, .395), (.62, .14, .05), 'glassb', bevel=0)                        # clerestory monitor
    gable_x(a, -.19, .43, -.18, .14, .42, .45, 'roof_hvy', oh=.01)
    for k in range(5): a.box((-.18 + k * .15, .053, .16), (.024, .02, .32), 'concrete2', bevel=.002, role='detail')
    roller_door(a, .12, .05, .30, .27)
    a.accent(.12, .07, .305, .32, .02, .012, .45)
    side_windows(a, .12, -.18, .67, .46, .05, 2, .12, 5, ('right',))
    a.box((-.39, -.2, .07), (.2, .36, .14), 'concrete', bevel=.01)                      # proof bunker, earth-banked
    a.prism([(-.5, -.39), (-.5, -.01), (-.47, -.01), (-.47, -.39)], 'z', 0, .1, 'earth', bevel=.01, inset=(1, .9))
    a.box((-.39, -.2, .146), (.21, .37, .012), 'concrete2', bevel=.003)
    # the gantry crane: legs on rails either side of the yard, a girder over the hall front, trolley and barrel
    for x in (-.24, .48):
        a.box((x, .02, .004), (.02, .84, .008), 'steel', bevel=0, role='ground')
        for y in (.1, .34):
            a.beam((x, y, 0), (x, y, .48), .011, 'crane', segs=6)
        a.beam((x, .1, .46), (x, .34, .46), .009, 'crane', segs=6)
        a.box((x, .22, .012), (.04, .3, .024), 'crane', bevel=.003)
    a.box((.12, .22, .49), (.76, .05, .05), 'crane', bevel=.004)
    for k in range(9): a.beam((-.24 + k * .09, .22, .465), (-.195 + k * .09, .22, .515), .003, 'dark', segs=4)
    a.accent(.12, .22, .515, .5, .012, .052, .35)
    a.box((.2, .22, .455), (.07, .07, .03), 'dark', bevel=.003)
    a.beam((.2, .22, .44), (.2, .22, .2), .002, 'steel', segs=4)
    a.cyl((.06, .22, .19), 'x', .016, .012, .3, 'gun', segs=10, bevel=0)                 # barrel on the hook
    # test pad and howitzer
    pad(a, .12, .3, .66, .3, 'tarmac')
    a.cyl((-.32, .3, .012), 'z', .1, .1, .008, 'concrete2', segs=20, bevel=0, role='ground')
    a.obox(-.32, .29, .012, .06, .09, .14, 0, 'olive', bevel=.006)
    a.cyl((-.32, .32, .055), (0, 1, .5), .012, .01, .2, 'gun', segs=8, bevel=0)
    for s in (-1, 1): a.beam((-.32 + s * .03, .24, .02), (-.32 + s * .08, .16, .008), .006, 'olive', segs=6)
    for k in range(3): a.box((.42, .4 - k * .045, .02), (.08, .035, .04), 'crate', bevel=.003)
    a.wall(.12, -.18, .69, .48); a.wall(-.39, -.2, .22, .38)
    a.mark(.12, .062, .245, .3, .03, .006)
    a.flag(-.44, .4, .4)
    emblem(a, .12, .0, .37 - .204 * .18, .15, -math.atan(.204))      # on the front slope of the hall roof
    return finish(a)

def airfield():
    """Two pale arched hangars with open doors, a glazed control tower with a beacon, the runway with thresholds and
    edge lights, a parked jet on the apron and an ops hut."""
    t = 'airfield'; a = Rec('Bld_' + t, t)
    plinth(a, 0, -.08, 1.04, .9)
    pad(a, -.11, .19, 1.05, .23)                                                    # runway
    for k in range(8): a.box((.2 - k * .12, .19, .0175), (.056, .006, .003), 'stripe', bevel=0, role='ground')
    for end in (-1, 1):
        for k in range(4): a.box((-.11 + end * .47, .19 + (k - 1.5) * .045, .0175), (.07, .026, .003), 'stripe', bevel=0, role='ground')
    for k in range(6):
        for s in (-1, 1): a.box((.25 - k * .17, .19 + s * .123, .02), (.014, .014, .012), 'lamp', bevel=0)
    pad(a, .1, -.05, .76, .2, 'concrete2')                                          # apron
    for x in (.31, -.08):                                                           # arched hangars, doors to the front
        def arch_of(r, z0=.02, h=.25, n=14):
            return [(x - r * math.cos(math.pi * k / n), z0 + h * (r / .175) * math.sin(math.pi * k / n)) for k in range(n + 1)]
        a.prism(arch_of(.175), 'y', -.455, -.125, 'roof_air', bevel=0)
        a.box((x, -.12, .1), (.26, .012, .18), 'interior', bevel=0, role='detail')   # the open door: dark bay
        for s in (-1, 1): a.box((x + s * .15, -.118, .09), (.05, .016, .17), 'sidingd', bevel=0)
        a.accent(x, -.112, .195, .28, .022, .012, .45)
        a.box((x, -.47, .1), (.3, .02, .2), 'siding', bevel=.003)
    # control tower
    a.box((-.42, -.29, .2), (.1, .12, .4), 'concrete', bevel=.006)
    a.prism(polygon(-.42, -.29, .1, 8, math.pi / 8), 'z', .40, .41, 'concrete2', bevel=0)
    a.prism(polygon(-.42, -.29, .1, 8, math.pi / 8), 'z', .41, .47, 'glassb', bevel=0, inset=(1.12, 1.12))
    a.prism(polygon(-.42, -.29, .118, 8, math.pi / 8), 'z', .47, .485, 'roofl', bevel=.003)
    a.beam((-.42, -.29, .485), (-.42, -.29, .57), .004, 'steel', segs=6)
    a.beacon(-.42, -.29, .585, .032, 1.2)
    a.box((-.36, -.42, .05), (.12, .1, .1), 'siding', bevel=.005)
    # ops hut, fuel bowser, windsock
    a.box((-.43, .44, .05), (.25, .12, .1), 'siding', bevel=.005)
    a.box((-.43, .44, .105), (.27, .14, .012), 'roof_air', bevel=.002)
    for k in range(2): a.cyl((-.2 + k * .07, -.47, .03), 'x', .025, .025, .06, 'white', segs=12, bevel=0)
    a.beam((.47, .02, 0), (.47, .02, .22), .005, 'steel', segs=6)
    for k in range(3): a.cyl((.47 + k * .04, .02, .2), 'x', .02 - k * .004, .016 - k * .004, .04, 'hazard' if k % 2 == 0 else 'white', segs=8, bevel=0)
    jet(a, .1, -.03, math.pi / 2 + .25)
    a.wall(.31, -.29, .35, .33); a.wall(-.08, -.29, .35, .33); a.wall(-.42, -.29, .16, .19); a.wall(-.43, .44, .25, .12)
    a.mark(-.42, -.226, .3, .08, .03, .006)
    a.box((.31, -.29, .2375), (.2, .22, .075), 'sidingd', bevel=.004)
    emblem(a, .31, -.29, .275, .16)
    return finish(a)

def generator():
    """A dark turbine hall with a tall stack, two hyperbolic cooling towers breathing steam (accent bands) and a
    transformer yard with portal gantries and lines in front."""
    t = 'power_plant'; a = Rec('Bld_' + t, t)
    plinth(a, 0, -.08, 1.0, .9)
    a.box((-.19, -.22, .14), (.54, .51, .28), 'brick', bevel=.01)
    parapet_roof(a, -.19, -.22, .54, .51, .28, 'roof_gen')
    windows(a, -.19, -.22, .5, .51, .03, 1, .24, 5, ('front',), 'glassb')
    roller_door(a, -.04, .035, .14, .16)
    for k in range(3): hvac(a, -.38 + k * .1, -.40, .3)
    a.cyl((-.40, -.30, .30), 'z', .04, .032, .36, 'concrete2', segs=14, bevel=0)         # the stack
    for k in range(3): a.cyl((-.40, -.30, .42 + k * .08), 'z', .041 - k * .003, .041 - k * .003, .012, 'hazard', segs=14, bevel=0, role='detail')
    a.smoke(-.40, -.30, .68, False, .5)
    for (y, h) in ((-.30, .48), (.0, .42)):
        hyperboloid(a, .31, y, .118, h)
        a.band(.31, y, .1, h * .7, .03, 18, 0., .35, accent=True)
        a.smoke(.31, y, h + .03, True, .5 if h > .45 else .42)
    # transformer yard: plinths, transformers with fins, insulators, portal gantries, lines
    pad(a, -.26, .3, .46, .24, 'concrete2')
    for k in range(3):
        x = -.4 + k * .14
        a.box((x, .28, .055), (.08, .07, .09), 'sidingd', bevel=.005)
        for j in range(4): a.box((x - .03 + j * .02, .318, .055), (.006, .008, .08), 'dark', bevel=0)
        for j in range(3): a.cyl((x - .025 + j * .025, .27, .1), 'z', .006, .004, .045, 'concrete3', segs=6, bevel=0)
    for x in (-.47, -.05):
        for y in (.2, .40): a.beam((x, y, 0), (x, y, .2), .006, 'steel', segs=4)
        a.beam((x, .2, .2), (x, .40, .2), .005, 'steel', segs=4)
    for y in (.24, .3, .36): a.beam((-.47, y, .195), (-.05, y, .195), .0015, 'dark', segs=4)
    for k in range(5): a.box((-.49 + k * .11, .44, .03), (.004, .004, .06), 'steel', bevel=0)
    a.wall(-.19, -.22, .56, .53); a.wall(.31, -.15, .24, .58); a.wall(-.26, .28, .3, .1)
    a.mark(-.04, .042, .2, .14, .025, .006)
    emblem(a, -.12, -.15, .293, .2)
    return finish(a)

def processor():
    """The materials processor: an ochre processing hall, a battery of three tall silos with accent bands, an elevated
    hopper bin, a hopper tower over the truck bay and conveyor galleries tying them together; ore heaps in front."""
    t = 'depot'; a = Rec('Bld_' + t, t)
    plinth(a, 0, -.08, 1.02, .9)
    a.box((-.07, -.17, .11), (.77, .58, .22), 'siding', bevel=.008)
    for k in range(9): a.box((-.43 + k * .09, .123, .11), (.01, .006, .22), 'sidingd', bevel=0, role='detail')
    parapet_roof(a, -.07, -.17, .77, .58, .22, 'roof_dep')
    a.box((-.07, -.3, .27), (.6, .14, .08), 'roof_dep', bevel=.004)                     # raised crusher house
    windows(a, -.07, -.3, .58, .14, .22, 1, .07, 7, ('front',), 'glassb')
    for bay in range(2): roller_door(a, -.32 + bay * .25, .12, .16, .15)
    for k in range(3):                                                                   # silo battery
        y = -.47 + k * .16
        silo(a, .40, y, .052, .44, 'concrete3', .05)
        a.band(.40, y, .056, .30, .035, 14, 0., .35, accent=True)
    a.box((.40, -.31, .5), (.06, .4, .02), 'steel', bevel=.002)
    # elevated hopper bin on legs (rear left)
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((-.39 + sx * .07, -.45 + sy * .07, 0), (-.39 + sx * .07, -.45 + sy * .07, .18), .007, 'steel', segs=6)
    a.lathe([(0, .1), (.03, .1), (.1, .18), (.1, .38), (.05, .42), (0, .42)], 'z', 'roof_dep', segs=16, center=(-.39, -.45, 0))
    # hopper tower over the truck bay (front right)
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((.39 + sx * .09, .2 + sy * .1, 0), (.39 + sx * .09, .2 + sy * .1, .34), .008, 'steel', segs=6)
    a.prism([(.31, .11), (.47, .11), (.47, .29), (.31, .29)], 'z', .2, .34, 'rust', bevel=.004, inset=(1, 1))
    a.prism([(.37, .18), (.41, .18), (.41, .22), (.37, .22)], 'z', .12, .2, 'rust', bevel=0, inset=(3.5, 3.5))
    a.box((.39, .2, .35), (.18, .2, .014), 'roof_dep', bevel=.002)
    # conveyors: ground hopper -> crusher house -> silos -> hopper tower
    a.prism([(-.36, .30), (-.26, .30), (-.26, .40), (-.36, .40)], 'z', 0, .07, 'rust', bevel=.003, inset=(1.2, 1.2))
    conveyor(a, (-.31, .33, .07), (-.25, -.23, .31), 2)
    conveyor(a, (.2, -.3, .31), (.4, -.31, .51), 1)
    conveyor(a, (.4, -.11, .5), (.39, .12, .35), 1)
    for (x, y, r, h, k) in ((-.12, .34, .09, .07, 'ore'), (.02, .38, .07, .05, 'coal'), (.14, .34, .08, .06, 'ore')):
        a.cyl((x, y, .005), 'z', r, .01, h, k, segs=12, bevel=0)
    a.wall(-.07, -.17, .78, .59); a.wall(.39, .2, .22, .26); a.wall(.4, -.31, .1, .44); a.wall(-.39, -.45, .2, .2)
    for bay in range(2): a.mark(-.32 + bay * .25, .13, .19, .03, .02, .015)
    emblem(a, -.1, -.04, .233, .2)
    return finish(a)

def lab():
    """The systems lab: a white two-storey institute with a glass band and an observatory dome, a test wing with an
    antenna array, a big radome on its drum (accent ring) and a dish on a pedestal."""
    t = 'advanced_lab'; a = Rec('Bld_' + t, t)
    plinth(a, 0, -.08, 1.04, .9)
    a.box((.22, -.23, .15), (.43, .47, .30), 'roof_lab', bevel=.01)
    a.box((.22, -.23, .16), (.44, .48, .05), 'glassb', bevel=0, role='glass')
    windows(a, .22, -.23, .4, .47, .02, 1, .1, 5, ('front', 'back'), 'glassb')
    parapet_roof(a, .22, -.23, .43, .47, .30, 'roofl')
    a.cyl((.22, -.3, .30), 'z', .13, .13, .04, 'concrete2', segs=24, bevel=0)
    a.lathe([(0, .34), (.125, .34)] + [(.125 * math.cos(k * math.pi / 16), .34 + .125 * math.sin(k * math.pi / 16)) for k in range(1, 9)], 'z', 'concrete3', segs=24)
    a.box((.22, -.3, .43), (.03, .2, .09), 'dark', bevel=0, role='detail')                # the dome's slit
    a.box((-.30, -.19, .1), (.34, .56, .2), 'concrete', bevel=.008)
    parapet_roof(a, -.30, -.19, .34, .56, .2, 'roofl')
    windows(a, -.30, -.19, .34, .56, .0, 2, .09, 4, ('front',), 'glassb')
    side_windows(a, -.30, -.19, .34, .56, .0, 2, .09, 6, ('left',), 'glassb')
    a.box((-.03, -.2, .09), (.12, .2, .18), 'glassb', bevel=0)                            # glass atrium link
    a.box((-.03, -.2, .186), (.13, .21, .012), 'roofl', bevel=.002)
    for k in range(3):                                                                    # antenna array on the wing
        x = -.40 + k * .1
        a.beam((x, -.43, .21), (x, -.43, .52), .004, 'steel', segs=6)
        for j in range(2): a.box((x, -.43, .44 + j * .05), (.07 - j * .02, .005, .005), 'white', bevel=0)
    # radome on its drum at the front corner, dish on a pedestal
    a.cyl((-.30, .30, 0), 'z', .1, .1, .09, 'concrete', segs=20, bevel=.003)
    a.band(-.30, .30, .104, .075, .03, 20, 0., .55, accent=True)
    a.ellipsoid((-.30, .30, .17), (.11, .11, .1), 'roof_lab', segs=20, rings=10)
    a.cyl((.33, .27, 0), 'z', .04, .03, .12, 'concrete2', segs=12, bevel=0)
    dish(a, .33, .27, .16, .1, (-.3, .5, 1))
    pad(a, .06, .31, .4, .22, 'tarmac')
    a.wall(.22, -.23, .43, .47); a.wall(-.30, -.19, .34, .56)
    a.mark(.22, .007, .27, .14, .03, .006)
    a.flag(.42, .29, .42)
    emblem(a, -.30, -.1, .213, .2)
    return finish(a)

def missile_silo():
    """The strategic missile facility: a hardstand with two massive blast doors (hazard seam), earth-and-concrete
    berms each side, a rear blast wall, a white missile on its erector with a service tower, and a low control bunker
    with its dish."""
    t = 'missile_silo'; a = Rec('Bld_' + t, t)
    plinth(a, .05, -.17, 1.12, .96)
    a.box((.1, -.17, .025), (.76, .76, .05), 'concrete2', bevel=.008)                  # hardstand
    for s in (-1, 1):
        a.box((.1 + s * .185, -.17, .065), (.35, .66, .035), 'concrete3', bevel=.006)   # blast doors
        for k in range(5): a.box((.1 + s * .185, -.45 + k * .14, .085), (.33, .02, .006), 'concrete2', bevel=0, role='detail')
        a.box((.1 + s * .375, -.17, .055), (.02, .7, .02), 'steel', bevel=0, role='detail')
    for k in range(10): a.box((.1, -.49 + k * .07, .086), (.012, .035, .004), 'hazard' if k % 2 == 0 else 'dark', bevel=0, role='detail')
    for x in (.56, -.36):                                                                  # berms
        a.prism([(x - .045, -.56), (x + .045, -.56), (x + .045, .22), (x - .045, .22)], 'z', 0, .1, 'earth', bevel=.01, inset=(.6, .98))
        a.box((x, -.17, .105), (.03, .76, .012), 'grass', bevel=0)
    a.box((.1, -.62, .07), (.9, .066, .14), 'concrete', bevel=.006)                     # rear blast wall
    # the erector and missile, service tower
    a.box((.1, -.5, .1), (.1, .08, .04), 'gun', bevel=.004)
    a.beam((.1, -.54, .1), (.1, -.54, .78), .012, 'steel', segs=6)
    for k in range(5): a.box((.1, -.525, .18 + k * .13), (.06, .03, .01), 'steel', bevel=0)
    a.cyl((.1, -.48, .12), 'z', .045, .045, .52, 'white', segs=14, bevel=0)
    a.band(.1, -.48, .047, .4, .05, 14, 0., .5, accent=True)
    a.cyl((.1, -.48, .64), 'z', .045, .004, .13, 'white', segs=14, bevel=0)
    for k in range(4):
        ang = k * math.pi / 2 + math.pi / 4
        a.obox(.1 + math.sin(ang) * .05, -.48 + math.cos(ang) * .05, .12, .2, .006, .05, ang, 'dark', bevel=0)
    lattice_mast(a, .26, -.5, .05, .6, w=.07)
    for k in range(3): a.box((.2, -.5, .25 + k * .17), (.11, .03, .008), 'steel', bevel=0)
    # control bunker
    a.box((-.39, .17, .085), (.21, .32, .17), 'concrete', bevel=.012)
    a.prism([(-.5, .0), (-.28, .0), (-.28, .34), (-.5, .34)], 'z', 0, .12, 'earth', bevel=.01, inset=(1.08, 1.05))
    a.box((-.39, .17, .176), (.22, .33, .014), 'concrete2', bevel=.003)
    roller_door(a, -.39, .33, .1, .11)
    dish(a, -.42, .12, .3, .07, (.3, .4, 1))
    for k in range(3): a.cyl((-.35 + k * .025, .26, .183), 'z', .004, .004, .08 + k * .03, 'steel', segs=4, bevel=0)
    a.wall(.1, -.17, .76, .76); a.wall(.56, -.17, .08, .78); a.wall(-.36, -.17, .08, .78); a.wall(.1, -.62, .9, .066)
    a.wall(-.39, .17, .23, .34)
    a.mark(-.39, .332, .15, .12, .025, .006)
    a.flag(.45, .32, .42)
    emblem(a, .1, .0, .089, .26)
    return finish(a)

# ================================================================== field defenses (bodies; heads stay in build_defenses.py)
def bag_arc(a, r, a0, a1, rows=3, bag=.05, key='sandbag', z0=0., cy=0.):
    length = abs(a1 - a0) * r
    n = max(1, int(length / bag))
    for row in range(rows):
        for k in range(n + (row % 2 == 0)):
            t = (k + (.5 if row % 2 == 0 else 1.0)) / (n + 1)
            ang = a0 + (a1 - a0) * t
            a.obox(math.sin(ang) * r, cy + math.cos(ang) * r, z0 + row * .021, z0 + row * .021 + .022, bag * .96, .032,
                   ang + math.pi / 2, key if (k + row) % 3 else 'sandbag2', bevel=.005)

def bag_line(a, x0, y0, x1, y1, rows=3, bag=.05, z0=0.):
    length = math.hypot(x1 - x0, y1 - y0); ang = math.atan2(x1 - x0, y1 - y0)
    n = max(1, int(length / bag))
    for row in range(rows):
        for k in range(n):
            t = (k + .5 + (row % 2) * .5) / (n + .5)
            a.obox(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + row * .021, z0 + row * .021 + .022, .032, bag * .96, ang,
                   'sandbag' if (k + row) % 3 else 'sandbag2', bevel=.005)

def crates(a, x, y, n=2):
    for k in range(n):
        a.box((x + k * .045, y, .018), (.04, .03, .036), 'crate', bevel=.003)
        a.box((x + k * .045, y, .037), (.042, .032, .003), 'olive', bevel=0)

def barrel(a, base, d, length, r0, r1, key='gun', segs=10, brake=True):
    a.cyl(base, d, r0, r1, length, key, segs=segs, bevel=0)
    if brake:
        tip = tuple(base[i] + d[i] * length for i in range(3))
        a.cyl(tip, d, r1 * 1.7, r1 * 1.7, length * .1, 'gun', segs=8, bevel=0)

def chevron_plate(a, x, y, z):
    a.box((x, y, z), (.09, .008, .05), 'concrete2', bevel=.002, role='detail')
    a.plate(x, y, z)

def d_barricade():
    a = Rec('Bld_barricade', 'barricade')
    bag_arc(a, .62, -.42, .42, rows=3, cy=-.62)
    a.box((0, -.09, .002), (.44, .12, .004), 'earth', bevel=0, role='ground')
    for k in range(5): a.beam((-.2 + k * .1, .15, 0), (-.2 + k * .1, .15, .07), .004, 'timber')
    for s in (-1, 1): a.beam((-.2, .15, .06 if s > 0 else .03), (.2, .15, .06 if s > 0 else .03), .002, 'gun')
    for s in (-1, 1):
        x = s * .21
        for ang in (0, math.pi / 3, -math.pi / 3):
            a.beam((x - math.cos(ang) * .04, .1 - math.sin(ang) * .04, .0), (x + math.cos(ang) * .04, .1 + math.sin(ang) * .04, .065), .007, 'gun')
    for k in range(3):
        ang = -.32 + k * .32
        a.wall(math.sin(ang) * .62, math.cos(ang) * .62 - .62, .22, .05, ang)
    return finish(a)

def d_guard_post():
    a = Rec('Bld_guard_post', 'guard_post')
    a.prism(polygon(0, 0, .19, 8, math.pi / 8), 'z', -.03, .012, 'concrete2', bevel=.004, role='ground')
    h = .40
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((sx * .11, sy * .11, 0), (sx * .075, sy * .075, h), .011, 'timber', segs=6)
    for k in range(3):
        z0, z1 = .03 + k * .12, .03 + (k + 1) * .12
        for (p, q) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
            s0 = .11 - (.035 * z0 / h); s1 = .11 - (.035 * z1 / h)
            a.beam((p[0] * s0, p[1] * s0, z0), (q[0] * s1, q[1] * s1, z1), .004, 'timber', segs=4)
    for k in range(7): a.box((.105, -.06, .02 + k * .05), (.006, .05, .006), 'gun', bevel=0)
    for s in (-1, 1): a.beam((.105, s * .025, 0), (.105, s * .025, .37), .003, 'gun', segs=4)
    a.box((0, 0, h + .006), (.23, .23, .014), 'concrete2', bevel=.003, role='shell')
    for (x0, y0, x1, y1) in ((-.10, .10, .10, .10), (.10, -.10, .10, .10), (-.10, -.10, -.10, .10)):
        bag_line(a, x0, y0, x1, y1, rows=2, z0=h + .013)
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((sx * .105, sy * .105, h + .01), (sx * .105, sy * .105, h + .13), .005, 'timber', segs=4)
    a.prism([(-.15, -.15), (.15, -.15), (.15, .15), (-.15, .15)], 'z', h + .13, h + .145, 'roofm', bevel=.003, inset=(.75, .75), role='shell')
    a.box((0, 0, h + .15), (.13, .13, .012), 'roofm', bevel=.002)
    barrel(a, (0, .09, h + .07), (0, 1, 0), .10, .009, .007)
    a.box((0, .085, h + .065), (.03, .05, .025), 'gun', bevel=.003)
    a.cyl((-.08, .09, h + .14), (0, 1, -.2), .02, .024, .03, 'gun', segs=10, bevel=0)
    a.cyl((-.08, .121, h + .134), (0, 1, -.2), .021, .021, .003, 'window', segs=10, bevel=0)
    a.blast_override = {1: [se_buildkit.Blast((.1, .1, h + .1), .1)],
                        2: [se_buildkit.Blast((.1, .1, h + .1), .14), se_buildkit.Blast((-.08, -.05, h + .14), .12, .2, True), se_buildkit.Blast((.11, .11, .2), .06)]}
    a.wall(0, 0, .26, .26)
    a.mark(0, .107, h + .03, .1, .025, .006)
    return finish(a)

def d_bunker():
    a = Rec('Bld_bunker', 'bunker')
    a.ring(.25, .38, -.02, .05, 'earth', segs=16, taper=.78, role='ground')
    a.prism(polygon(0, 0, .27, 8, math.pi / 8), 'z', -.02, .13, 'concrete', bevel=.008, inset=(.86, .86))
    a.prism(polygon(0, 0, .265, 8, math.pi / 8), 'z', .13, .175, 'concrete2', bevel=.01, inset=(.92, .92))
    a.prism(polygon(0, 0, .17, 8, math.pi / 8), 'z', .175, .195, 'concrete', bevel=.006, inset=(.85, .85))
    for k in range(5):
        ang = (k - 2) * math.tau / 8
        a.obox(math.sin(ang) * .228, math.cos(ang) * .228, .075, .098, .13, .03, ang, 'slit', bevel=0, role='detail')
        a.obox(math.sin(ang) * .238, math.cos(ang) * .238, .068, .074, .15, .03, ang, 'concrete2', bevel=0, role='detail')
    barrel(a, (0, .2, .086), (0, 1, 0), .1, .01, .008)
    a.box((0, -.33, .0), (.08, .16, .01), 'earth', bevel=0, role='ground')
    bag_line(a, -.06, -.26, -.06, -.42, rows=2); bag_line(a, .06, -.26, .06, -.42, rows=2)
    a.box((0, -.235, .05), (.07, .01, .09), 'slit', bevel=0)
    chevron_plate(a, 0, .245, .155)
    a.wall(0, 0, .5, .5); a.wall(0, 0, .5, .5, math.pi / 4)
    a.mark(0, 0, .197, .12, .006, .12)
    return finish(a)

def d_at():
    a = Rec('Bld_turret', 'turret')
    a.ring(.23, .33, -.02, .045, 'earth', segs=18, taper=.82)
    a.cyl((0, 0, -.02), 'z', .235, .235, .032, 'concrete2', segs=18, bevel=0, role='ground')
    bag_arc(a, .24, -2.3, 2.3, rows=3)
    crates(a, -.12, -.17, 2); crates(a, .08, -.17, 1)
    a.cyl((0, 0, .012), 'z', .1, .1, .012, 'gun', segs=16, bevel=0, role='ground')
    chevron_plate(a, 0, .305, .04)
    a.blast_override = {1: [se_buildkit.Blast((.18, .12, .05), .1)], 2: [se_buildkit.Blast((.18, .12, .05), .13), se_buildkit.Blast((-.2, .05, .05), .12), se_buildkit.Blast((0, -.25, .04), .1)]}
    a.wall(0, 0, .52, .52)
    a.mount(0, 0, .024)
    return finish(a)

def d_aa():
    a = Rec('Bld_aa_battery', 'aa_battery')
    a.prism(polygon(0, 0, .30, 8, math.pi / 8), 'z', -.03, .04, 'concrete2', bevel=.006, role='shell')
    for k in range(8):
        a0 = k * math.tau / 8 + .12; a1 = (k + 1) * math.tau / 8 - .12
        if k == 4: continue
        bag_arc(a, .265, a0, a1, rows=2, z0=.04)
    for k in range(3):
        ang = math.pi + (k - 1) * .5
        a.obox(math.sin(ang) * .19, math.cos(ang) * .19, .04, .085, .07, .03, ang, 'olive', bevel=.003)
        for j in range(4): a.cyl((math.sin(ang) * .19 + (j - 1.5) * .014 * math.cos(ang), math.cos(ang) * .19 - (j - 1.5) * .014 * math.sin(ang), .085), 'z', .005, .004, .025, 'hazard', segs=6, bevel=0)
    a.cyl((0, 0, .04), 'z', .11, .11, .014, 'gun', segs=16, bevel=0, role='detail')
    chevron_plate(a, 0, .29, .07)
    a.blast_override = {1: [se_buildkit.Blast((.2, .14, .06), .1)], 2: [se_buildkit.Blast((.2, .14, .06), .14), se_buildkit.Blast((-.18, -.12, .06), .13), se_buildkit.Blast((-.05, .25, .05), .08)]}
    a.wall(0, 0, .56, .56); a.wall(0, 0, .56, .56, math.pi / 4)
    a.mount(0, 0, .054)
    return finish(a)

def d_mg():
    a = Rec('Bld_city_turret', 'city_turret')
    a.prism(polygon(0, 0, .16, 6, math.pi / 6), 'z', -.03, .07, 'concrete', bevel=.006, inset=(.88, .88))
    bag_arc(a, .175, -2.5, 2.5, rows=2)
    a.cyl((0, 0, .07), 'z', .07, .07, .01, 'gun', segs=12, bevel=0, role='detail')
    chevron_plate(a, 0, .135, .045)
    a.blast_override = {1: [se_buildkit.Blast((.12, .08, .06), .07)], 2: [se_buildkit.Blast((.12, .08, .06), .1), se_buildkit.Blast((-.1, -.1, .07), .09)]}
    a.wall(0, 0, .26, .26)
    a.mount(0, 0, .08)
    return finish(a)

def d_fort():
    a = Rec('Bld_fort', 'fort')
    outer = polygon(0, 0, .47, 6, math.pi / 6)
    for k in range(6):
        (x0, y0), (x1, y1) = outer[k], outer[(k + 1) % 6]
        ang = math.atan2(x1 - x0, y1 - y0); L = math.hypot(x1 - x0, y1 - y0)
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        if k == 3:
            for s in (-1, 1):
                ox, oy = mx + math.sin(ang) * s * L * .32, my + math.cos(ang) * s * L * .32
                a.obox(ox, oy, -.02, .10, .06, L * .36, ang, 'concrete', bevel=.006)
            continue
        a.obox(mx, my, -.02, .10, .065, L * .86, ang, 'concrete', bevel=.006)
        a.obox(mx * 1.08, my * 1.08, -.02, .045, .07, L * .9, ang, 'earth', bevel=.01)
    for k, (x, y) in enumerate(outer):
        a.prism(polygon(x, y, .075, 6, math.pi / 6), 'z', -.02, .15, 'concrete2', bevel=.006)
        a.prism(polygon(x, y, .08, 6, math.pi / 6), 'z', .15, .165, 'concrete', bevel=.004)
    a.cyl((0, 0, -.02), 'z', .41, .41, .025, 'earth', segs=6, bevel=0, role='ground')
    a.prism(polygon(0, 0, .17, 8, math.pi / 8), 'z', 0, .17, 'concrete', bevel=.008)
    a.prism(polygon(0, 0, .175, 8, math.pi / 8), 'z', .17, .19, 'concrete2', bevel=.004)
    for k in range(8):
        ang = k * math.tau / 8
        a.obox(math.sin(ang) * .165, math.cos(ang) * .165, .10, .12, .08, .02, ang, 'slit', bevel=0, role='detail')
    crates(a, .17, -.2, 2); crates(a, -.25, .08, 2)
    a.cyl((-.22, -.14, 0), 'z', .007, .006, .5, 'concrete2', segs=6, bevel=0)
    chevron_plate(a, 0, .175, .145)
    for k in range(6):
        (x0, y0), (x1, y1) = outer[k], outer[(k + 1) % 6]
        ang = math.atan2(x1 - x0, y1 - y0)
        if k != 3: a.wall((x0 + x1) / 2, (y0 + y1) / 2, .07, math.hypot(x1 - x0, y1 - y0) * .86, ang)
    a.wall(0, 0, .34, .34); a.wall(0, 0, .34, .34, math.pi / 4)
    a.flag(-.22, -.14, .5)
    a.mark(0, 0, .192, .12, .006, .12)
    a.mount(0, 0, .19)
    return finish(a)

def d_sensor():
    a = Rec('Bld_sensor_post', 'sensor_post')
    a.prism(polygon(0, 0, .22, 8, math.pi / 8), 'z', -.03, .015, 'concrete2', bevel=.004, role='ground')
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((sx * .06, sy * .06, 0), (sx * .02, sy * .02, .55), .005, 'gun', segs=4, role='tall')
    for k in range(7):
        z = .02 + k * .075; s = .06 - .04 * z / .55
        for (p, q) in (((-1, -1), (1, 1)), ((1, -1), (-1, 1))):
            a.beam((p[0] * s, p[1] * s, z), (q[0] * s, q[1] * s, z + .075), .002, 'gun', segs=4)
    a.box((.11, -.08, .055), (.13, .1, .09), 'olive', bevel=.006)
    a.box((.11, -.08, .104), (.15, .12, .01), 'roofm', bevel=.003)
    bag_arc(a, .2, .6, 2.6, rows=2)
    a.box((0, 0, .555), (.05, .05, .02), 'gun', bevel=.003)
    chevron_plate(a, -.06, .16, .04)
    a.wall(.11, -.08, .13, .1)
    a.mount(0, 0, .57)
    return finish(a)

def d_artillery():
    a = Rec('Bld_artillery_post', 'artillery_post')
    a.ring(.30, .42, -.02, .06, 'earth', segs=20, taper=.8)
    a.cyl((0, 0, -.02), 'z', .31, .31, .03, 'concrete2', segs=20, bevel=0, role='ground')
    bag_arc(a, .31, -2.4, 2.4, rows=3)
    a.prism([(-.12, -.36), (.12, -.36), (.1, -.24), (-.1, -.24)], 'z', -.02, .07, 'concrete', bevel=.006)
    a.box((0, -.235, .03), (.06, .01, .05), 'slit', bevel=0)
    crates(a, .16, -.2, 2)
    a.cyl((0, 0, .01), 'z', .13, .13, .01, 'gun', segs=16, bevel=0, role='ground')
    chevron_plate(a, 0, .39, .05)
    a.blast_override = {1: [se_buildkit.Blast((.25, .2, .05), .12)], 2: [se_buildkit.Blast((.25, .2, .05), .16), se_buildkit.Blast((-.28, .1, .05), .14), se_buildkit.Blast((0, -.3, .06), .12, .16, True)]}
    a.wall(0, -.3, .24, .12)
    a.mount(0, 0, .02)
    return finish(a)

def d_repair():
    a = Rec('Bld_repair_point', 'repair_point')
    a.prism([(-.26, -.22), (.26, -.22), (.26, .22), (-.26, .22)], 'z', -.03, .012, 'concrete2', bevel=.006, role='ground')
    for k in range(6): a.box((-.25 + k * .1, .215, .013), (.05, .012, .002), 'hazard', bevel=0, role='ground')
    for s in (-1, 1):
        for y in (-.15, .15): a.beam((s * .2, y, 0), (s * .2, y, .3), .009, 'hazard', segs=6, role='tall')
        a.beam((s * .2, -.15, .3), (s * .2, .15, .3), .008, 'hazard', segs=6, role='shell')
    a.box((0, 0, .305), (.42, .03, .022), 'hazard', bevel=.003, role='shell')
    a.box((.05, 0, .26), (.04, .04, .05), 'gun', bevel=.003); a.beam((.05, 0, .235), (.05, 0, .14), .0015, 'gun', segs=4)
    a.box((-.2, -.19, .05), (.09, .06, .1), 'olive', bevel=.005, role='shell'); crates(a, .12, -.19, 2)
    for k in range(2): a.cyl((.22, .02 + k * .05, 0), 'z', .02, .02, .07, 'gun', segs=10, bevel=0)
    chevron_plate(a, -.12, .222, .04)
    a.blast_override = {1: [se_buildkit.Blast((.2, .1, .28), .1)], 2: [se_buildkit.Blast((.2, .1, .28), .14), se_buildkit.Blast((-.2, -.15, .1), .12), se_buildkit.Blast((-.2, .12, .3), .1)]}
    a.wall(-.2, -.19, .09, .06)
    return finish(a)

# ================================================================== build
makers = [lambda: headquarters(1), lambda: headquarters(2), lambda: headquarters(3), barracks, vehicle_works, heavy_weapons,
          airfield, generator, processor, lab, missile_silo,
          d_barricade, d_guard_post, d_bunker, d_at, d_aa, d_mg, d_fort, d_sensor, d_artillery, d_repair]
for m in makers: m()
recs = [r for r in BUILT if not ONLY or r.name in ONLY or r.t in ONLY]

stats, layout = [], []
for r in recs:
    t0 = time.time()
    row = [r.name]
    for stage in range(4):
        a = realize(r, stage)
        v, f = a.export(os.path.join(OUT, a.name + '.bytes'), ao_radius=.07, ao_rays=12)
        lo = '-'
        if f > LOD_TRIS:
            b = realize(r, stage, lod=True)
            _, lo = b.export(os.path.join(OUT, b.name + '.bytes'), ao_radius=.07, ao_rays=8)
        else:
            p = os.path.join(OUT, a.name + '_lo.bytes')
            if os.path.exists(p): os.remove(p)
        row.append('%d/%s' % (f, lo))
    stats.append('%-26s ' % row[0] + '  '.join('s%d %-12s' % (i, c) for i, c in enumerate(row[1:])))
    layout += r.layout_lines({1: blasts_for(r, 1), 2: blasts_for(r, 2)})
    print('[se] %s  (%.1fs)' % (stats[-1], time.time() - t0), flush=True)

if not ONLY:
    with open(os.path.join(OUT, 'BuildingLayout.txt'), 'w') as fh: fh.write('\n'.join(layout) + '\n')
    with open(os.path.join(HERE, 'BuildingStats.txt'), 'w') as fh:
        fh.write('triangles per stage: full/LOD (s0 intact, s1 damaged, s2 heavily damaged, s3 destroyed)\n' + '\n'.join(stats) + '\n')
print('[se] wrote %d buildings to %s' % (len(recs), OUT))
