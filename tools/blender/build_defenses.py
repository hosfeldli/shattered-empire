# Shattered Empires — field defenses, built in Blender (same kit and bake as build_bases.py).
#   headless:  "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_defenses.py -- <models dir>
# Frame: x right, +Y = the emplacement's front (Unity +Z), Z up, map units (a hex is 2 across; a tank is ~.5 long).
# Static bodies are Def_<type>.bytes; turret heads that track their target are separate meshes with their
# pivot at the origin (Def_<kind>_head<level>.bytes), placed by the client on the body's mount point.
# Writes DefenseLayout.txt (same record format as BaseLayout.txt, plus):
#   mount <type> x z height         where the turret head's pivot sits on the body
import bpy, bmesh, sys, os, math, importlib
HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else r"D:/Projects/shattered_empires/tools/blender"
sys.path.insert(0, HERE)
import se_meshkit; importlib.reload(se_meshkit)
from se_meshkit import Asset, PAL, CONCRETE, SHEET, FABRIC, PLAIN, GLASS, SOIL, ARMOR

if 'SE_OUT' in globals(): OUT = SE_OUT
elif '--' in sys.argv: OUT = sys.argv[sys.argv.index('--') + 1]
else: OUT = os.path.join(os.getcwd(), 'out')
os.makedirs(OUT, exist_ok=True)

PAL.update({
    'concrete': ((.74, .72, .66), CONCRETE), 'concrete2': ((.60, .60, .56), CONCRETE), 'roofl': ((.72, .72, .69), CONCRETE),
    'sandbag': ((.66, .60, .46), FABRIC), 'sandbag2': ((.58, .53, .41), FABRIC), 'earth': ((.50, .43, .32), SOIL),
    'timber': ((.52, .40, .27), PLAIN), 'olive': ((.47, .51, .38), ARMOR), 'gun': ((.30, .31, .30), ARMOR),
    'hazard': ((.86, .66, .16), PLAIN), 'crate': ((.52, .41, .26), PLAIN), 'roofm': ((.60, .63, .61), SHEET),
    'slit': ((.08, .08, .08), PLAIN), 'window': ((.30, .42, .48), GLASS),
})
layout = []
def wall(t, x, y, w, d, yaw=0.): layout.append('wall %s %.4f %.4f %.4f %.4f %.4f' % (t, x, y, w / 2, d / 2, yaw))
def mark(t, x, y, z, w, h, d): layout.append('mark %s %.4f %.4f %.4f %.4f %.4f %.4f' % (t, x, y, z, w, h, d))
def flag(t, x, y, h): layout.append('flag %s %.4f %.4f %.4f' % (t, x, y, h))
def mount(t, x, y, h): layout.append('mount %s %.4f %.4f %.4f' % (t, x, y, h))
built = []

def save(a, ao=.06):
    v, f = a.export(os.path.join(OUT, a.name + '.bytes'), ao_radius=ao, ao_rays=14)
    print('[se] %-22s %5d verts %5d tris' % (a.name, v, f))
    built.append(a)
    return a

# ------------------------------------------------------------------ helpers
def ring_band(a, r0, r1, z0, z1, key, segs=24, taper=1.0):
    """A closed annular solid between radii r0 < r1, heights z0 < z1; taper scales the top radii (berms)."""
    bm = a.bm; before = set(bm.faces)
    rings = []
    for (r, z) in ((r0, z0), (r1, z0), (r1 * taper, z1), (r0, z1)):
        rings.append([bm.verts.new((math.cos(k / segs * math.tau) * r, math.sin(k / segs * math.tau) * r, z)) for k in range(segs)])
    for i in range(4):
        A, B = rings[i], rings[(i + 1) % 4]
        for k in range(segs):
            kk = (k + 1) % segs
            bm.faces.new((A[k], A[kk], B[kk], B[k]))
    faces = [f for f in bm.faces if f not in before]
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    return a._finish(faces, key, 0)

def obox(a, cx, cy, z0, z1, w, d, ang, key, bevel=.004):
    """A box w across and d along heading ang (0 = +Y), standing from z0 to z1."""
    s, c = math.sin(ang), math.cos(ang)
    pts = [(cx + u * c + v * s, cy - u * s + v * c) for (u, v) in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
    return a.prism(pts, 'z', z0, z1, key, bevel=bevel)

def polygon(cx, cy, r, n, phase=0.):
    return [(cx + math.sin(phase + k * math.tau / n) * r, cy + math.cos(phase + k * math.tau / n) * r) for k in range(n)]

def bag_arc(a, r, a0, a1, rows=3, bag=.05, key='sandbag', z0=0., cy=0.):
    """Sandbags stacked along an arc of radius r from angle a0 to a1 (0 = +Y, clockwise in plan)."""
    length = abs(a1 - a0) * r
    n = max(1, int(length / bag))
    for row in range(rows):
        for k in range(n + (row % 2 == 0)):
            t = (k + (.5 if row % 2 == 0 else 1.0)) / (n + 1)
            ang = a0 + (a1 - a0) * t
            obox(a, math.sin(ang) * r, cy + math.cos(ang) * r, z0 + row * .021, z0 + row * .021 + .022, bag * .96, .032,
                 ang + math.pi / 2, key if (k + row) % 3 else 'sandbag2', bevel=.005)

def bag_line(a, x0, y0, x1, y1, rows=3, bag=.05, z0=0.):
    length = math.hypot(x1 - x0, y1 - y0); ang = math.atan2(x1 - x0, y1 - y0)
    n = max(1, int(length / bag))
    for row in range(rows):
        for k in range(n):
            t = (k + .5 + (row % 2) * .5) / (n + .5)
            obox(a, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + row * .021, z0 + row * .021 + .022, .032, bag * .96, ang,
                 'sandbag' if (k + row) % 3 else 'sandbag2', bevel=.005)

def crates(a, x, y, n=2):
    for k in range(n):
        a.box((x + k * .045, y, .018), (.04, .03, .036), 'crate', bevel=.003)
        a.box((x + k * .045, y, .037), (.042, .032, .003), 'olive', bevel=0)

def barrel(a, base, direction, length, r0, r1, key='gun', segs=10, brake=True):
    d = direction
    a.cyl(base, d, r0, r1, length, key, segs=segs, bevel=0)
    if brake:
        tip = tuple(base[i] + d[i] * length for i in range(3))
        a.cyl(tip, d, r1 * 1.7, r1 * 1.7, length * .1, 'gun', segs=8, bevel=0)

def unit(v):
    l = math.sqrt(sum(c * c for c in v)); return tuple(c / l for c in v)

def chevron_plate(a, t, x, y, z):
    """A small front plate the client paints team chevrons on (one per upgrade level)."""
    a.box((x, y, z), (.09, .008, .05), 'concrete2', bevel=.002)
    layout.append("plate %s %.4f %.4f %.4f" % (t, x, y, z))

# ------------------------------------------------------------------ static bodies
def barricade():
    t = 'barricade'; a = Asset('Def_' + t)
    bag_arc(a, .62, -.42, .42, rows=3, cy=-.62)               # a shallow arc, centre of curvature behind
    a.box((0, -.09, .002), (.44, .12, .004), 'earth', bevel=0)
    for k in range(5):                                        # wire pickets on the enemy side
        x = -.2 + k * .1
        a.beam((x, .15, 0), (x, .15, .07), .004, 'timber')
    for s in (-1, 1): a.beam((-.2, .15, .06 if s > 0 else .03), (.2, .15, .06 if s > 0 else .03), .002, 'gun')
    for s in (-1, 1):                                         # hedgehogs at the ends
        x = s * .21
        for ang in (0, math.pi / 3, -math.pi / 3):
            a.beam((x - math.cos(ang) * .04, .1 - math.sin(ang) * .04, .0), (x + math.cos(ang) * .04, .1 + math.sin(ang) * .04, .065), .007, 'gun')
    save(a)
    for k in range(3):
        ang = -.32 + k * .32
        wall(t, math.sin(ang) * .62, math.cos(ang) * .62 - .62, .22, .05, ang)

def guard_post():
    """A watchtower: four braced legs, a sandbagged cabin with a searchlight and a front MG."""
    t = 'guard_post'; a = Asset('Def_' + t)
    a.prism(polygon(0, 0, .19, 8, math.pi / 8), 'z', -.03, .012, 'concrete2', bevel=.004)
    h = .40
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((sx * .11, sy * .11, 0), (sx * .075, sy * .075, h), .011, 'timber', segs=6)
    for k in range(3):
        z0, z1 = .03 + k * .12, .03 + (k + 1) * .12
        for (p, q) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
            s0 = .11 - (.035 * z0 / h); s1 = .11 - (.035 * z1 / h)
            a.beam((p[0] * s0, p[1] * s0, z0), (q[0] * s1, q[1] * s1, z1), .004, 'timber', segs=4)
    for k in range(7): a.box((.105, -.06 + k * .02 * 0, .02 + k * .05), (.006, .05, .006), 'gun', bevel=0)   # ladder rungs
    for s in (-1, 1): a.beam((.105, s * .025, 0), (.105, s * .025, .37), .003, 'gun', segs=4)
    a.box((0, 0, h + .006), (.23, .23, .014), 'concrete2', bevel=.003)                  # floor
    for (x0, y0, x1, y1) in ((-.10, .10, .10, .10), (.10, -.10, .10, .10), (-.10, -.10, -.10, .10)):
        bag_line(a, x0, y0, x1, y1, rows=2, z0=h + .013)
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((sx * .105, sy * .105, h + .01), (sx * .105, sy * .105, h + .13), .005, 'timber', segs=4)
    a.prism([(-.15, -.15), (.15, -.15), (.15, .15), (-.15, .15)], 'z', h + .13, h + .145, 'roofm', bevel=.003, inset=(.75, .75))
    a.box((0, 0, h + .15), (.13, .13, .012), 'roofm', bevel=.002)
    barrel(a, (0, .09, h + .07), (0, 1, 0), .10, .009, .007)                             # MG
    a.box((0, .085, h + .065), (.03, .05, .025), 'gun', bevel=.003)
    a.cyl((-.08, .09, h + .14), (0, 1, -.2), .02, .024, .03, 'gun', segs=10, bevel=0)   # searchlight
    a.cyl((-.08, .121, h + .134), (0, 1, -.2), .021, .021, .003, 'window', segs=10, bevel=0)
    save(a)
    wall(t, 0, 0, .26, .26)
    mark(t, 0, .107, h + .03, .1, .025, .006)

def bunker():
    """A low octagonal pillbox in an earth berm: firing slits all round, an entrance trench at the back."""
    t = 'bunker'; a = Asset('Def_' + t)
    ring_band(a, .25, .38, -.02, .05, 'earth', segs=16, taper=.78)                      # berm
    a.prism(polygon(0, 0, .27, 8, math.pi / 8), 'z', -.02, .13, 'concrete', bevel=.008, inset=(.86, .86))
    a.prism(polygon(0, 0, .265, 8, math.pi / 8), 'z', .13, .175, 'concrete2', bevel=.01, inset=(.92, .92))
    a.prism(polygon(0, 0, .17, 8, math.pi / 8), 'z', .175, .195, 'concrete', bevel=.006, inset=(.85, .85))
    for k in range(5):                                                                 # slits (front five faces)
        ang = (k - 2) * math.tau / 8
        obox(a, math.sin(ang) * .228, math.cos(ang) * .228, .075, .098, .13, .03, ang, 'slit', bevel=0)
        obox(a, math.sin(ang) * .238, math.cos(ang) * .238, .068, .074, .15, .03, ang, 'concrete2', bevel=0)
    barrel(a, (0, .2, .086), (0, 1, 0), .1, .01, .008)
    # rear entrance: a short sandbagged trench
    a.box((0, -.33, .0), (.08, .16, .01), 'earth', bevel=0)
    bag_line(a, -.06, -.26, -.06, -.42, rows=2); bag_line(a, .06, -.26, .06, -.42, rows=2)
    a.box((0, -.235, .05), (.07, .01, .09), 'slit', bevel=0)
    chevron_plate(a, t, 0, .245, .155)
    save(a)
    wall(t, 0, 0, .5, .5); wall(t, 0, 0, .5, .5, math.pi / 4)
    mark(t, 0, 0, .197, .12, .006, .12)

def at_base():
    """Anti-armor emplacement: a sandbag and earth revetment ring open at the back, ready ammunition."""
    t = 'turret'; a = Asset('Def_at_base')
    ring_band(a, .23, .33, -.02, .045, 'earth', segs=18, taper=.82)
    a.cyl((0, 0, -.02), 'z', .235, .235, .032, 'concrete2', segs=18, bevel=0)           # gun floor
    bag_arc(a, .24, -2.3, 2.3, rows=3)
    crates(a, -.12, -.17, 2); crates(a, .08, -.17, 1)
    a.cyl((0, 0, .012), 'z', .1, .1, .012, 'gun', segs=16, bevel=0)                     # turntable ring
    chevron_plate(a, t, 0, .305, .04)
    save(a)
    wall(t, 0, 0, .52, .52)
    mount(t, 0, 0, .024)

def aa_base():
    """AA battery: an octagonal concrete platform behind a sandbag parapet, ready racks and a director."""
    t = 'aa_battery'; a = Asset('Def_aa_base')
    a.prism(polygon(0, 0, .30, 8, math.pi / 8), 'z', -.03, .04, 'concrete2', bevel=.006)
    for k in range(8):
        a0 = k * math.tau / 8 + .12; a1 = (k + 1) * math.tau / 8 - .12
        if k == 4: continue                                                          # rear gap
        bag_arc(a, .265, a0, a1, rows=2, z0=.04)
    for k in range(3):                                                               # shell racks
        ang = math.pi + (k - 1) * .5
        obox(a, math.sin(ang) * .19, math.cos(ang) * .19, .04, .085, .07, .03, ang, 'olive', bevel=.003)
        for j in range(4): a.cyl((math.sin(ang) * .19 + (j - 1.5) * .014 * math.cos(ang), math.cos(ang) * .19 - (j - 1.5) * .014 * math.sin(ang), .085), 'z', .005, .004, .025, 'hazard', segs=6, bevel=0)
    a.cyl((0, 0, .04), 'z', .11, .11, .014, 'gun', segs=16, bevel=0)
    chevron_plate(a, t, 0, .29, .07)
    save(a)
    wall(t, 0, 0, .56, .56); wall(t, 0, 0, .56, .56, math.pi / 4)
    mount(t, 0, 0, .054)

def mg_base():
    """Perimeter turret: a squat concrete plinth with a sandbag collar."""
    t = 'city_turret'; a = Asset('Def_mg_base')
    a.prism(polygon(0, 0, .16, 6, math.pi / 6), 'z', -.03, .07, 'concrete', bevel=.006, inset=(.88, .88))
    bag_arc(a, .175, -2.5, 2.5, rows=2)
    a.cyl((0, 0, .07), 'z', .07, .07, .01, 'gun', segs=12, bevel=0)
    chevron_plate(a, t, 0, .135, .045)
    save(a)
    wall(t, 0, 0, .26, .26)
    mount(t, 0, 0, .08)

def fort():
    """Outpost: a hexagonal earth-and-concrete star fort, bastion towers, a central blockhouse with a gun."""
    t = 'fort'; a = Asset('Def_' + t)
    outer = polygon(0, 0, .47, 6, math.pi / 6)
    for k in range(6):                                                              # curtain walls
        (x0, y0), (x1, y1) = outer[k], outer[(k + 1) % 6]
        ang = math.atan2(x1 - x0, y1 - y0); L = math.hypot(x1 - x0, y1 - y0)
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        if k == 3:                                                                   # the gate side
            for s in (-1, 1):
                ox, oy = mx + math.sin(ang) * s * L * .32, my + math.cos(ang) * s * L * .32
                obox(a, ox, oy, -.02, .10, .06, L * .36, ang, 'concrete', bevel=.006)
            continue
        obox(a, mx, my, -.02, .10, .065, L * .86, ang, 'concrete', bevel=.006)
        obox(a, mx * 1.08, my * 1.08, -.02, .045, .07, L * .9, ang, 'earth', bevel=.01)
    for k, (x, y) in enumerate(outer):                                              # bastions
        a.prism(polygon(x, y, .075, 6, math.pi / 6), 'z', -.02, .15, 'concrete2', bevel=.006)
        a.prism(polygon(x, y, .08, 6, math.pi / 6), 'z', .15, .165, 'concrete', bevel=.004)
    a.cyl((0, 0, -.02), 'z', .41, .41, .025, 'earth', segs=6, bevel=0)                 # inner yard
    a.prism(polygon(0, 0, .17, 8, math.pi / 8), 'z', 0, .17, 'concrete', bevel=.008)   # blockhouse
    a.prism(polygon(0, 0, .175, 8, math.pi / 8), 'z', .17, .19, 'concrete2', bevel=.004)
    for k in range(8):
        ang = k * math.tau / 8
        obox(a, math.sin(ang) * .165, math.cos(ang) * .165, .10, .12, .08, .02, ang, 'slit', bevel=0)
    crates(a, .17, -.2, 2); crates(a, -.25, .08, 2)
    a.cyl((-.22, -.14, 0), 'z', .007, .006, .5, 'concrete2', segs=6, bevel=0)
    chevron_plate(a, t, 0, .175, .145)
    save(a)
    for k in range(6):
        (x0, y0), (x1, y1) = outer[k], outer[(k + 1) % 6]
        ang = math.atan2(x1 - x0, y1 - y0)
        if k != 3: wall(t, (x0 + x1) / 2, (y0 + y1) / 2, .07, math.hypot(x1 - x0, y1 - y0) * .86, ang)
    wall(t, 0, 0, .34, .34); wall(t, 0, 0, .34, .34, math.pi / 4)
    flag(t, -.22, -.14, .5)
    mark(t, 0, 0, .192, .12, .006, .12)
    mount(t, 0, 0, .19)

def sensor_post():
    t = 'sensor_post'; a = Asset('Def_' + t)
    a.prism(polygon(0, 0, .22, 8, math.pi / 8), 'z', -.03, .015, 'concrete2', bevel=.004)
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        a.beam((sx * .06, sy * .06, 0), (sx * .02, sy * .02, .55), .005, 'gun', segs=4)
    for k in range(7):
        z = .02 + k * .075; s = .06 - .04 * z / .55
        for (p, q) in (((-1, -1), (1, 1)), ((1, -1), (-1, 1))):
            a.beam((p[0] * s, p[1] * s, z), (q[0] * s, q[1] * s, z + .075), .002, 'gun', segs=4)
    a.box((.11, -.08, .055), (.13, .1, .09), 'olive', bevel=.006); a.box((.11, -.08, .104), (.15, .12, .01), 'roofm', bevel=.003)
    bag_arc(a, .2, .6, 2.6, rows=2)
    a.box((0, 0, .555), (.05, .05, .02), 'gun', bevel=.003)
    chevron_plate(a, t, -.06, .16, .04)
    save(a)
    wall(t, .11, -.08, .13, .1)
    mount(t, 0, 0, .57)

def artillery_base():
    t = 'artillery_post'; a = Asset('Def_artillery_base')
    ring_band(a, .30, .42, -.02, .06, 'earth', segs=20, taper=.8)
    a.cyl((0, 0, -.02), 'z', .31, .31, .03, 'concrete2', segs=20, bevel=0)
    bag_arc(a, .31, -2.4, 2.4, rows=3)
    a.prism([(-.12, -.36), (.12, -.36), (.1, -.24), (-.1, -.24)], 'z', -.02, .07, 'concrete', bevel=.006)    # ammo bunker
    a.box((0, -.235, .03), (.06, .01, .05), 'slit', bevel=0)
    crates(a, .16, -.2, 2)
    a.cyl((0, 0, .01), 'z', .13, .13, .01, 'gun', segs=16, bevel=0)
    chevron_plate(a, t, 0, .39, .05)
    save(a)
    wall(t, 0, -.3, .24, .12)
    mount(t, 0, 0, .02)

def repair_point():
    t = 'repair_point'; a = Asset('Def_' + t)
    a.prism([(-.26, -.22), (.26, -.22), (.26, .22), (-.26, .22)], 'z', -.03, .012, 'concrete2', bevel=.006)
    for k in range(6): a.box((-.25 + k * .1, .215, .013), (.05, .012, .002), 'hazard', bevel=0)
    for s in (-1, 1):
        for y in (-.15, .15): a.beam((s * .2, y, 0), (s * .2, y, .3), .009, 'hazard', segs=6)
        a.beam((s * .2, -.15, .3), (s * .2, .15, .3), .008, 'hazard', segs=6)
    a.box((0, 0, .305), (.42, .03, .022), 'hazard', bevel=.003)
    a.box((.05, 0, .26), (.04, .04, .05), 'gun', bevel=.003); a.beam((.05, 0, .235), (.05, 0, .14), .0015, 'gun', segs=4)
    a.box((-.2, -.19, .05), (.09, .06, .1), 'olive', bevel=.005); crates(a, .12, -.19, 2)
    for k in range(2): a.cyl((.22, .02 + k * .05, 0), 'z', .02, .02, .07, 'gun', segs=10, bevel=0)
    chevron_plate(a, t, -.12, .222, .04)
    save(a)
    wall(t, -.2, -.19, .09, .06)

def perimeter_wall():
    """One T-wall section for tier walls around the sockets: the client lays them in runs."""
    a = Asset('Def_wall')
    a.prism([(-.13, -.06), (.13, -.06), (.13, .06), (-.13, .06)], 'z', -.02, .018, 'concrete2', bevel=.004)
    a.prism([(-.125, -.022), (.125, -.022), (.125, .022), (-.125, .022)], 'z', .018, .13, 'concrete', bevel=.005, inset=(1, .7))
    a.box((0, 0, .126), (.25, .028, .008), 'concrete2', bevel=.002)
    for s in (-1, 1): a.box((s * .125, 0, .07), (.006, .034, .1), 'sandbag2', bevel=0)
    save(a, ao=.04)

def trench_post():
    """A trench-side revetment post with a sandbag cap (for the trench renderer)."""
    a = Asset('Def_trench_post')
    a.beam((0, 0, -.06), (0, 0, .07), .008, 'timber', segs=6)
    for k in range(3): obox(a, 0, .01, .0 + k * .02, .02 + k * .02, .05, .03, 0, 'sandbag' if k % 2 else 'sandbag2', bevel=.004)
    save(a, ao=.04)

# ------------------------------------------------------------------ turret heads (pivot at the origin)
def at_head(level):
    a = Asset('Def_at_head%d' % level)
    a.cyl((0, 0, 0), 'z', .085, .08, .03, 'olive', segs=14, bevel=0)                   # carriage
    twin = level >= 3
    for s in ((-1, 1) if twin else (0,)):
        x = s * .028
        a.box((x, .02, .055), (.05, .14, .045), 'olive', bevel=.006)                    # cradle and breech
        barrel(a, (x, .09, .058), (0, 1, .04), .30 if level >= 2 else .26, .014, .011)
    # gun shield: a bent armour plate, bigger and closed at the top from level 2
    w = .2 if not twin else .24
    for s in (-1, 1):
        obox(a, s * w * .32, .095, .01, .13, w * .38, .016, s * -.35, 'paint', bevel=.004)
    obox(a, 0, .11, .01, .13, w * .4, .016, 0, 'paint', bevel=.004)
    if level >= 2:
        a.prism([(-w / 2, -.03), (w / 2, -.03), (w * .42, .11), (-w * .42, .11)], 'z', .13, .145, 'paint', bevel=.004)
        for s in (-1, 1): obox(a, s * w * .5, .02, .01, .13, .016, .16, 0, 'paint', bevel=.004)
    if level >= 3:
        a.box((0, -.07, .08), (.1, .06, .07), 'paint', bevel=.006)                      # armoured breech housing
    a.box((.07, .03, .145), (.03, .04, .02), 'gun', bevel=.003)                          # sight
    save(a)

def aa_head(level):
    a = Asset('Def_aa_head%d' % level)
    a.cyl((0, 0, 0), 'z', .1, .095, .03, 'olive', segs=16, bevel=0)                     # turntable
    for s in (-1, 1):                                                                  # cradle cheeks
        a.prism([(-.05, .01), (.05, .01), (.07, .11), (-.03, .11)], 'x', s * .07 - .012, s * .07 + .012, 'paint', bevel=.004)
    a.box((0, .0, .05), (.12, .07, .05), 'paint', bevel=.006)                             # mount body
    a.box((0, -.01, .1), (.06, .01, .03), 'gun', bevel=.002)                             # gunner sight
    elev = math.radians(52)
    d = (0, math.cos(elev), math.sin(elev))
    pairs = [(-.026, .026)] if level == 1 else [(-.05, -.02), (.02, .05)]
    for xs in pairs:
        for x in xs:
            barrel(a, (x, .02, .075), d, .28, .009, .007, segs=8)
            a.cyl((x, .02 + d[1] * .07, .075 + d[2] * .07), d, .016, .016, .05, 'gun', segs=8, bevel=0)   # recoil jackets
    for s in (-1, 1):                                                                  # ammo drums
        a.cyl((s * (.085 if level == 1 else .105), -.01, .06), 'x', .028, .028, .025, 'olive', segs=12, bevel=0)
    if level >= 2:
        for s in (-1, 1): obox(a, s * .1, .04, .02, .1, .014, .09, 0, 'paint', bevel=.004)    # splinter shields
    if level >= 3:                                                                      # fire-control radar
        a.beam((0, -.07, .03), (0, -.07, .17), .006, 'gun', segs=6)
        a.cyl((0, -.07, .17), (0, -.4, 1), .06, .012, .025, 'concrete', segs=14, bevel=0)
    save(a)

def mg_head(level):
    a = Asset('Def_mg_head%d' % level)
    a.lathe([(0, 0), (.07, 0), (.075, .03), (.06, .07), (0, .085)], 'z', 'paint', segs=14)   # cupola
    a.box((0, .055, .045), (.05, .03, .025), 'gun', bevel=.003)
    xs = (0,) if level == 1 else (-.018, .018)
    for x in xs: barrel(a, (x, .065, .045), (0, 1, 0), .13, .007, .006, segs=6, brake=False)
    if level >= 2:
        a.box((0, .06, .085), (.035, .03, .012), 'window', bevel=.002)
    if level >= 3:
        obox(a, 0, .085, .0, .075, .14, .014, 0, 'paint', bevel=.003)                 # shield
        a.cyl((-.055, .0, .085), (0, 1, -.15), .016, .018, .025, 'gun', segs=8, bevel=0)  # searchlight
    save(a)

def fort_head():
    a = Asset('Def_fort_head')
    a.prism(polygon(0, 0, .12, 8, math.pi / 8), 'z', 0, .07, 'paint', bevel=.006, inset=(.82, .82))
    a.box((0, .07, .035), (.07, .06, .05), 'paint', bevel=.005)
    barrel(a, (0, .1, .04), (0, 1, .05), .32, .016, .012)
    a.cyl((-.05, -.04, .07), 'z', .025, .025, .02, 'gun', segs=10, bevel=0)
    save(a)

def artillery_head():
    a = Asset('Def_artillery_head')
    a.cyl((0, 0, 0), 'z', .12, .11, .03, 'olive', segs=16, bevel=0)
    a.box((0, .0, .07), (.1, .2, .07), 'paint', bevel=.006)
    for s in (-1, 1): obox(a, s * .075, .06, .02, .14, .016, .16, 0, 'paint', bevel=.004)
    d = unit((0, 1, .36))
    barrel(a, (0, .08, .09), d, .40, .022, .016)
    a.box((0, -.12, .05), (.08, .06, .05), 'olive', bevel=.005)
    save(a)

barricade(); guard_post(); bunker(); at_base(); aa_base(); mg_base(); fort(); sensor_post(); artillery_base(); repair_point()
perimeter_wall(); trench_post()
for lv in (1, 2, 3): at_head(lv); aa_head(lv); mg_head(lv)
fort_head(); artillery_head()
with open(os.path.join(OUT, 'DefenseLayout.txt'), 'w') as fh: fh.write('\n'.join(layout) + '\n')
print('[se] wrote %d defense models and %d layout records to %s' % (len(built), len(layout), OUT))
