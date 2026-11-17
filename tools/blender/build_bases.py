# Shattered Empires — authored base facilities, built in Blender.
#   live (Blender MCP):  exec(open(path).read(), {"__name__": "__main__", "__file__": path, "SE_OUT": models_dir})
#   headless:            "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_bases.py -- <models dir>
# Frame: x right, +Y = the building's front (Unity +Z), Z up; one parcel is about 1.0 x 0.9 units and a
# storey 0.12. Writes Base_<type>.bytes (SEM1, rigid) and BaseLayout.txt, one line per record:
#   wall <type> x z halfW halfD yaw      solid walls (collision and infantry avoidance)
#   mark <type> x z y w h d              faction-coloured panels (Unity frame, metres in units)
#   flag <type> x z height               animated flag poles
#   smoke <type> x z height steam size   smoke stacks
import bpy, bmesh, sys, os, math, importlib
HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else r"D:/Projects/shattered_empires/tools/blender"
sys.path.insert(0, HERE)
import se_meshkit; importlib.reload(se_meshkit)
from se_meshkit import Asset, PAL, CONCRETE, BRICK, SHEET, ASPHALT, FABRIC, PLAIN, GLASS

if 'SE_OUT' in globals(): OUT = SE_OUT
elif '--' in sys.argv: OUT = sys.argv[sys.argv.index('--') + 1]
else: OUT = os.path.join(os.getcwd(), 'out')
os.makedirs(OUT, exist_ok=True)

PAL.update({
    'concrete': ((.74, .72, .66), CONCRETE), 'concrete2': ((.60, .60, .56), CONCRETE),
    'brick': ((.66, .60, .52), BRICK), 'roofm': ((.60, .63, .61), SHEET), 'roofl': ((.72, .72, .69), CONCRETE), 'siding': ((.60, .63, .60), SHEET),
    'sidingd': ((.42, .45, .44), SHEET), 'tarmac': ((.36, .37, .36), ASPHALT), 'window': ((.30, .42, .48), GLASS),
    'sandbag': ((.64, .58, .45), FABRIC), 'gabion': ((.56, .52, .42), FABRIC), 'olive2': ((.40, .44, .32), PLAIN),
    'hazard': ((.86, .66, .16), PLAIN), 'rust': ((.55, .37, .26), SHEET), 'crate': ((.50, .38, .24), PLAIN),
})
layout = []
def wall(t, x, y, w, d, yaw=0.): layout.append('wall %s %.4f %.4f %.4f %.4f %.4f' % (t, x, y, w / 2, d / 2, yaw))
def mark(t, x, y, z, w, h, d): layout.append('mark %s %.4f %.4f %.4f %.4f %.4f %.4f' % (t, x, y, z, w, h, d))
def flag(t, x, y, h): layout.append('flag %s %.4f %.4f %.4f' % (t, x, y, h))
def smoke(t, x, y, h, steam, size): layout.append('smoke %s %.4f %.4f %.4f %d %.3f' % (t, x, y, h, 1 if steam else 0, size))

def rounded_outline(cx, cy, w, d, r, n=4):
    """A rounded-rectangle plan outline (counter-clockwise), corner radius r with n segments per corner."""
    pts = []
    for (sx, sy, a0) in ((1, -1, -90), (1, 1, 0), (-1, 1, 90), (-1, -1, 180)):
        ox, oy = cx + sx * (w / 2 - r), cy + sy * (d / 2 - r)
        for k in range(n + 1):
            ang = math.radians(a0 + 90 * k / n)
            pts.append((ox + math.cos(ang) * r, oy + math.sin(ang) * r))
    return pts

def plinth(a, cx, cy, w, d):
    # rounded corners, matching the client's rounded socket pads the plinth stands on
    a.prism(rounded_outline(cx, cy, w, d, .09), 'z', -.13, .01, 'concrete2', bevel=.008)

def windows(a, cx, cy, w, d, z0, floors, storey, n, sides=('front', 'back')):
    for f in range(floors):
        z = z0 + storey * (f + .55)
        for k in range(n):
            x = cx - w / 2 + (k + .5) * w / n
            if 'front' in sides:
                a.box((x, cy + d / 2 + .003, z), (w / n * .55, .006, storey * .42), 'window', bevel=0)
                a.box((x, cy + d / 2 + .008, z - storey * .25), (w / n * .66, .012, .008), 'concrete', bevel=0)
            if 'back' in sides:
                a.box((x, cy - d / 2 - .003, z), (w / n * .55, .006, storey * .42), 'window', bevel=0)

def hesco(a, x, y, n, along_x=True):
    for k in range(n):
        px, py = (x + k * .085, y) if along_x else (x, y + k * .085)
        a.box((px, py, .045), (.08, .08, .09), 'gabion', bevel=.006)
        a.box((px, py, .092), (.082, .082, .006), 'webbing', bevel=0)

def sandbags(a, x, y, length, along_x=True, rows=3):
    for r in range(rows):
        n = int(length / .05)
        for k in range(n):
            off = -length / 2 + (k + .5 + (r % 2) * .5) * length / n
            px, py = (x + off, y) if along_x else (x, y + off)
            a.box((px, py, .012 + r * .022), (.048 if along_x else .03, .03 if along_x else .048, .022), 'sandbag', bevel=.006)

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

def hvac(a, x, y, z):
    a.box((x, y, z + .025), (.09, .07, .05), 'siding', bevel=.005)
    a.cyl((x, y, z + .05), 'z', .025, .025, .006, 'grille', segs=12, bevel=0)

def ring_band(a, r0, r1, z0, z1, key, segs=24):
    """A closed annular solid (tube) between radii r0 < r1 and heights z0 < z1: parapets, collars, bands."""
    bm = a.bm; before = set(bm.faces)
    rings = []
    for (r, z) in ((r0, z0), (r1, z0), (r1, z1), (r0, z1)):
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
    """A box of width w (across) and depth d (along ang), turned to heading ang (radians, 0 = +Y)."""
    s, c = math.sin(ang), math.cos(ang)
    pts = []
    for (u, v) in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
        pts.append((cx + u * c + v * s, cy - u * s + v * c))
    return a.prism(pts, 'z', z0, z1, key, bevel=bevel)

def headquarters():
    """The command hub: a round, stepped drum on a circular podium, read from every side. Docking gates,
    arms and the team ring are drawn by the client toward the actual sockets (they move with the slot count)."""
    t = 'town'; a = Asset('Base_' + t)
    a.lathe([(0, -.08), (.66, -.08), (.66, .018), (.635, .036), (0, .036)], 'z', 'concrete2', segs=32)       # podium
    ring_band(a, .55, .60, .036, .05, 'sidingd', segs=32)                                                       # dock collar
    a.lathe([(0, .03), (.50, .03), (.50, .225), (.475, .24), (0, .24)], 'z', 'concrete', segs=28)            # lower drum
    ring_band(a, .495, .508, .095, .165, 'window', segs=28)                                                     # window band
    for z in (.09, .17): ring_band(a, .49, .516, z, z + .008, 'concrete2', segs=28)
    for k in range(16):                                                                                          # pilasters
        ang = (k + .5) * math.tau / 16
        obox(a, math.sin(ang) * .505, math.cos(ang) * .505, .03, .23, .026, .03, ang, 'concrete2', bevel=.003)
    a.lathe([(0, .235), (.37, .235), (.37, .35), (0, .35)], 'z', 'concrete', segs=24)                         # upper drum
    ring_band(a, .372, .378, .26, .33, 'window', segs=24)
    ring_band(a, .35, .392, .345, .375, 'concrete2', segs=24)                                                   # parapet
    a.cyl((0, 0, .345), 'z', .352, .352, .012, 'roofl', segs=24, bevel=0)                                      # roof deck
    for k in range(4):                                                                                           # roof plant
        ang = k * math.tau / 4 + math.tau / 8
        x, y = math.sin(ang) * .26, math.cos(ang) * .26
        a.box((x, y, .382), (.08, .06, .045), 'siding', bevel=.004)
        a.cyl((x, y, .404), 'z', .022, .022, .006, 'grille', segs=10, bevel=0)
    # the command tower and its glazed cab
    a.lathe([(0, .35), (.15, .35), (.15, .55), (0, .55)], 'z', 'concrete', segs=20)
    a.lathe([(0, .55), (.17, .55), (.205, .60), (.185, .65), (0, .65)], 'z', 'window', segs=20)
    a.lathe([(0, .65), (.215, .65), (.215, .672), (.06, .69), (0, .69)], 'z', 'roofl', segs=20)
    for k in range(10):                                                                                          # cab mullions
        ang = k * math.tau / 10
        a.beam((math.sin(ang) * .172, math.cos(ang) * .172, .552), (math.sin(ang) * .205, math.cos(ang) * .205, .60), .004, 'concrete2')
        a.beam((math.sin(ang) * .205, math.cos(ang) * .205, .60), (math.sin(ang) * .186, math.cos(ang) * .186, .648), .004, 'concrete2')
    lattice_mast(a, 0, 0, .69, .28, w=.045)
    a.cyl((-.24, -.18, .375), 'z', .012, .012, .06, 'steel', segs=8, bevel=0)                                 # dish
    a.cyl((-.24, -.18, .435), (-.45, -.3, .84), .085, .012, .04, 'concrete', segs=18, bevel=0)
    for s in (-1, 1): floodlight(a, s * .58, -.25, .30)
    a.export(os.path.join(OUT, a.name + '.bytes'), ao_radius=.08, ao_rays=16)
    wall(t, 0, 0, .98, .98); wall(t, 0, 0, .98, .98, math.pi / 4)
    for (x, y, w, d) in ((0, .371, .2, .006), (0, -.371, .2, .006), (.371, 0, .006, .2), (-.371, 0, .006, .2)):
        mark(t, x, y, .30, w, .03, d)
    flag(t, -.42, .45, .5); flag(t, .42, .45, .5)
    return a

def barracks():
    t = 'barracks'; a = Asset('Base_' + t)
    plinth(a, 0, -.08, 1.0, .9)
    a.box((-.17, -.2, .14), (.6, .42, .27), 'brick', bevel=.01)
    a.box((-.17, -.2, .015), (.62, .44, .03), 'concrete2', bevel=.004)                 # plinth course
    a.prism([(-.43, .27), (.03, .27), (-.2, .37)], 'x', -.5, .16, 'roofm', bevel=.004)  # pitched roof
    for k in range(11): a.box((-.47 + k * .06, -.2, .33), (.006, .2, .006), 'sidingd', bevel=0)
    windows(a, -.17, -.2, .56, .42, .02, 2, .125, 6)
    a.box((-.17, .025, .21), (.12, .05, .012), 'roofm', bevel=.003)                    # entrance canopy
    a.box((-.17, .012, .06), (.08, .006, .11), 'sidingd', bevel=0)
    # mess annex
    a.box((.3, .02, .08), (.34, .52, .16), 'siding', bevel=.008)
    a.box((.3, .02, .165), (.36, .54, .014), 'roofm', bevel=.004)
    windows(a, .3, .02, .3, .52, .01, 1, .14, 3, ('front',))
    # external stair to the upper floor, rooftop tank, air units on the wall
    for k in range(9): a.box((.15, -.33 + k * .022, .015 + k * .016), (.06, .03, .012), 'steel', bevel=0)
    a.beam((.18, -.33, .03), (.18, -.15, .17), .003); a.beam((.18, -.15, .17), (.18, -.15, .2), .003)
    a.cyl((-.36, -.3, .32), 'z', .045, .045, .07, 'concrete2', segs=14, bevel=0)
    for x in (-.4, -.12, .06): hvac(a, x, -.43, .1)
    # parade ground, sandbags, gabions
    a.box((-.16, .27, .002), (.46, .26, .006), 'tarmac', bevel=0)
    sandbags(a, .3, .37, .25); hesco(a, -.48, .4, 3)
    floodlight(a, -.46, .2)
    a.export(os.path.join(OUT, a.name + '.bytes'), ao_radius=.08, ao_rays=16)
    wall(t, -.17, -.2, .62, .44); wall(t, .3, .02, .36, .54); wall(t, .3, .37, .26, .04)
    mark(t, -.17, .009, .19, .09, .03, .006); flag(t, -.42, .37, .40)
    return a

def supply_center():
    t = 'depot'; a = Asset('Base_' + t)
    plinth(a, 0, -.08, 1.02, .9)
    a.box((-.07, -.17, .12), (.77, .58, .24), 'siding', bevel=.008)
    arc = [(-.46 + (.58) * (1 - math.cos(math.pi * k / 12)) / 2, .24 + .1 * math.sin(math.pi * k / 12)) for k in range(13)]
    a.prism(arc, 'x', -.47, .33, 'roofm', bevel=0)                                      # barrel roof
    for k in range(7): a.box((-.43 + k * .12, -.17, .12), (.008, .59, .24), 'sidingd', bevel=0)
    # loading docks: platform, roller doors, bumpers, canopy
    a.box((-.07, .175, .04), (.74, .1, .08), 'concrete2', bevel=.004)
    for bay in range(3):
        x = -.32 + bay * .25
        a.box((x, .124, .13), (.17, .008, .17), 'sidingd', bevel=0)
        for r in range(6): a.box((x, .129, .06 + r * .027), (.17, .004, .004), 'siding', bevel=0)
        for s in (-1, 1): a.box((x + s * .06, .23, .05), (.02, .012, .04), 'rubber', bevel=.002)
    a.box((-.07, .19, .225), (.78, .16, .014), 'roofm', bevel=.003)
    # office annex
    a.box((.39, .2, .07), (.2, .24, .14), 'brick', bevel=.006); a.box((.39, .2, .145), (.22, .26, .012), 'roofm', bevel=.003)
    windows(a, .39, .2, .18, .24, .0, 1, .14, 2, ('front',))
    # containers, fuel tanks, pallets
    for i, (x, y, z, k) in enumerate([(.4, -.2, .05, 'rust'), (.4, -.42, .05, 'olive2'), (.4, -.31, .15, 'sidingd')]):
        a.box((x, y, z), (.1, .22, .1), k, bevel=.004)
        for r in range(7): a.box((x + .051, y - .09 + r * .03, z), (.004, .006, .09), k, bevel=0)
    for s in (-1, 1):
        a.cyl((-.47, -.45 + s * .05, .05), 'x', .04, .04, .16, 'siding', segs=14, bevel=0)
        for k in range(2): a.box((-.43 + k * .08, -.45 + s * .05, .015), (.012, .07, .03), 'concrete2', bevel=0)
    for k in range(4): a.box((-.42 + (k % 2) * .07, .35 + (k // 2) * .07, .03), (.055, .055, .06), 'crate', bevel=.004)
    a.export(os.path.join(OUT, a.name + '.bytes'), ao_radius=.08, ao_rays=16)
    wall(t, -.07, -.17, .78, .59); wall(t, .39, .2, .22, .26); wall(t, .4, -.31, .1, .44); wall(t, -.39, -.45, .2, .2)
    for bay in range(3): mark(t, -.32 + bay * .25, .13, .228, .03, .02, .015)
    return a

def vehicle_works():
    t = 'motor_works'; a = Asset('Base_' + t)
    plinth(a, 0, -.08, 1.04, .9)
    a.box((-.1, -.2, .15), (.78, .58, .3), 'brick', bevel=.01)
    for k in range(5):                                                                   # sawtooth north-light roof
        y0 = -.49 + k * .116
        a.prism([(y0, .3), (y0 + .116, .3), (y0 + .116, .37)], 'x', -.49, .29, 'roofm', bevel=.003)
        a.box((-.1, y0 + .116 + .002, .335), (.76, .004, .055), 'window', bevel=0)
    for bay in range(3):                                                                 # bay doors with hazard frames
        x = -.36 + bay * .26
        a.box((x, .093, .12), (.21, .008, .23), 'sidingd', bevel=0)
        for r in range(8): a.box((x, .098, .02 + r * .028), (.21, .004, .004), 'siding', bevel=0)
        for s in (-1, 1): a.box((x + s * .115, .095, .12), (.014, .01, .24), 'hazard', bevel=0)
        a.box((x, .1, .245), (.22, .02, .01), 'lamp', bevel=0)
    # office block
    a.box((.42, -.25, .09), (.22, .44, .18), 'brick', bevel=.008); a.box((.42, -.25, .185), (.24, .46, .012), 'roofm', bevel=.003)
    windows(a, .42, -.25, .22, .44, .0, 1, .17, 2)
    # yard: apron, gantry crane, tyre stacks, fuel island
    a.box((-.06, .3, .002), (.82, .34, .006), 'tarmac', bevel=0)
    for s in (-1, 1):
        a.beam((.33 + s * .08, .3, 0), (.33 + s * .08, .3, .24), .008, 'hazard'); a.beam((.33 + s * .08, .46, 0), (.33 + s * .08, .46, .24), .008, 'hazard')
    a.box((.33, .38, .245), (.2, .2, .016), 'hazard', bevel=.003); a.box((.33, .38, .2), (.02, .02, .09), 'dark', bevel=0)
    for k in range(3):
        for j in range(3): a.cyl((-.46 + k * .06, .43, .012 + j * .022), 'z', .026, .026, .02, 'rubber', segs=12, bevel=0)
    a.box((.1, .45, .04), (.05, .03, .08), 'olive2', bevel=.004); a.box((.1, .45, .12), (.14, .08, .01), 'roofm', bevel=.002)
    a.export(os.path.join(OUT, a.name + '.bytes'), ao_radius=.08, ao_rays=16)
    wall(t, -.1, -.2, .8, .6); wall(t, .42, -.25, .24, .46)
    mark(t, -.1, .1, .27, .74, .02, .006); flag(t, -.48, .41, .37)
    return a

def generator():
    t = 'power_plant'; a = Asset('Base_' + t)
    plinth(a, 0, -.08, 1.0, .9)
    a.box((-.19, -.22, .145), (.54, .51, .29), 'brick', bevel=.01)
    a.prism([(-.48, .29), (.04, .29), (-.22, .35)], 'x', -.47, .09, 'roofm', bevel=.004)
    windows(a, -.19, -.22, .5, .51, .03, 1, .25, 4)
    a.box((-.18, .037, .1), (.16, .008, .18), 'sidingd', bevel=0)
    for k in range(3):                                                                    # containerised gensets
        y = -.37 + k * .22
        a.box((.31, y, .012), (.28, .17, .024), 'concrete2', bevel=.003)
        a.box((.31, y, .08), (.22, .13, .11), 'olive2', bevel=.008)
        for j in range(5): a.box((.31 - .08 + j * .04, y + .066, .08), (.02, .004, .08), 'grille', bevel=0)
        a.cyl((.36, y - .03, .135), 'z', .016, .014, .14, 'steel', segs=10, bevel=0)
        smoke(t, .36, y - .03, .3, False, .35)
    for k in range(2):                                                                    # transformer yard
        a.box((-.36 + k * .2, .28, .07), (.1, .09, .14), 'sidingd', bevel=.006)
        for j in range(3): a.cyl((-.39 + k * .2 + j * .03, .28, .14), 'z', .006, .004, .05, 'concrete', segs=6, bevel=0)
    for k in range(4): a.beam((-.48 + k * .2, .4, 0), (-.48 + k * .2, .4, .1), .003)
    a.beam((-.48, .4, .095), (.12, .4, .095), .002)
    for k in range(3): a.cyl((-.37 + k * .16, -.42, .29), 'z', .022, .02, .26, 'concrete2', segs=12, bevel=0)
    for k in range(3): smoke(t, -.37 + k * .16, -.42, .56, k == 1, .5)
    a.export(os.path.join(OUT, a.name + '.bytes'), ao_radius=.08, ao_rays=16)
    wall(t, -.19, -.22, .56, .53); wall(t, .31, -.15, .24, .58); wall(t, -.26, .28, .3, .1)
    mark(t, -.18, .042, .2, .14, .025, .006)
    return a

built = [headquarters(), barracks(), supply_center(), vehicle_works(), generator()]
with open(os.path.join(OUT, 'BaseLayout.txt'), 'w') as fh: fh.write('\n'.join(layout) + '\n')
print('[se] wrote %d base models and %d layout records to %s' % (len(built), len(layout), OUT))

# Live preview in the open Blender session (skipped headless).
if not bpy.app.background:
    coll = bpy.data.collections.get('SE Bases') or bpy.data.collections.new('SE Bases')
    if coll.name not in bpy.context.scene.collection.children: bpy.context.scene.collection.children.link(coll)
    for ob in list(coll.objects): bpy.data.objects.remove(ob, do_unlink=True)
    for i, a in enumerate(built):
        ob = a.preview_object(coll); ob.location = (i * 1.25 - 2.5, 3, 0)
        ob.data.shade_smooth()
        if hasattr(ob.data, 'set_sharp_from_angle'): ob.data.set_sharp_from_angle(angle=math.radians(38))
