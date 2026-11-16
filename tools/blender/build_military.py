# Builds the close-range military models in Blender and writes them for Unity.
#   "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_military.py -- <out-dir>
# Units and pivots match Runtime/Rendering/MilitaryMeshes.cs (the code-built fallbacks): hulls stand on
# the origin facing +Y (Unity +Z); turrets turn about the vertical axis through the origin; barrels
# start at their trunnion and run along +Y; wheels are centred and roll about X; the main rotor sits on
# its hub at the origin. Every model is a real solid with chamfered edges and baked ambient occlusion.
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from se_meshkit import Asset

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(os.getcwd(), 'out')
os.makedirs(out, exist_ok=True)
built = []

def save(a, **kw):
    v, t = a.export(os.path.join(out, a.name + '.bytes'), **kw)
    built.append((a.name, v, t))
    print('[se] %-18s %6d verts %6d tris' % (a.name, v, t))

# ======================================================================= main battle tank hull
def tank_hull(name, autonomous=False, artillery=False):
    a = Asset(name)
    deck = .335 if not autonomous else .305
    # Lower hull side profile (y, z): rear plate, engine deck, flat roof, upper and lower glacis, belly.
    a.prism([(-.555, .10), (-.575, .30), (-.53, deck), (.18, deck), (.525, .225), (.55, .17), (.49, .085), (-.49, .085)],
            'x', -.30, .30, 'paint', bevel=.008)
    # Sponsons / fenders over the running gear, with a raked front fender.
    for s in (-1, 1):
        x0, x1 = (.30, .47) if s > 0 else (-.47, -.30)
        a.prism([(-.55, .255), (-.55, deck - .012), (.44, deck - .012), (.54, .275), (.52, .255)], 'x', x0, x1, 'paint', bevel=.006)
        # Side skirts outside the track run: six bolted panels, the front two heavier.
        for k in range(6):
            y0 = -.43 + k * .155
            thick = .016 if k < 4 else .024
            a.box((s * (.512 + thick * .5), y0 + .072, .222), (thick, .148, .118 if k < 4 else .126), 'edge' if k % 2 else 'paint', bevel=.004)
            a.cyl((s * (.512 + thick + .001), y0 + .02, .262), (s, 0, 0), .006, .006, .004, 'dark', segs=6, bevel=0)
            a.cyl((s * (.512 + thick + .001), y0 + .12, .262), (s, 0, 0), .006, .006, .004, 'dark', segs=6, bevel=0)
        a.box((s * .512, .48, .21), (.014, .07, .09), 'paint', bevel=.003, taper=(1, .6))
        # Drive sprocket (rear) and idler (front): toothed and spoked lathed wheels inside the track loop.
        a.lathe([(0, -.03), (.088, -.03), (.10, -.02), (.10, .02), (.088, .03), (0, .03)], 'x', 'dark', segs=20, center=(s * .434, -.40, .13))
        for t in range(12):
            ang = t / 12 * math.tau
            a.box((s * .434, -.40 + math.cos(ang) * .104, .13 + math.sin(ang) * .104), (.05, .016, .016), 'dark', bevel=0)
        a.lathe([(0, -.028), (.085, -.028), (.092, -.018), (.092, .018), (.085, .028), (0, .028)], 'x', 'steel', segs=20, center=(s * .434, .41, .14))
        # Return rollers on the hull side above the track's upper run.
        for k in range(3):
            a.cyl((.40 if s > 0 else -.46, -.20 + k * .20, .228), 'x', .018, .018, .06, 'dark', segs=10, bevel=0)
        # Headlight clusters with brush guards, tail lights, fender tool stowage.
        a.box((s * .40, .47, .318), (.06, .03, .03), 'dark', bevel=.003)
        a.box((s * .40, .487, .318), (.04, .006, .018), 'lamp', bevel=0)
        a.beam((s * .37, .49, .30), (s * .37, .50, .345), .004, 'steel'); a.beam((s * .43, .49, .30), (s * .43, .50, .345), .004, 'steel')
        a.box((s * .40, -.565, .30), (.045, .008, .022), 'tail', bevel=0)
        a.box((s * .385, -.10, deck + .018), (.13, .32, .03), 'edge', bevel=.004)     # stowage bin
        a.beam((s * .45, -.35, deck), (s * .45, .25, deck), .007, 'wood')          # tool handle
        a.box((s * .45, .28, deck), (.012, .06, .006), 'steel', bevel=0)            # shovel blade
        # Tow hooks and shackles.
        a.cyl((s * .20, .54, .14), 'y', .016, .016, .03, 'steel', segs=8)
        a.cyl((s * .22, -.585, .16), 'y', .016, .016, .025, 'steel', segs=8)
    # Driver's station: hatch, three periscopes; glacis splash guard.
    a.cyl((0.10, .30, deck - .005), 'z', .055, .052, .02, 'edge', segs=18)
    for k in range(3):
        a.box((.10 + (k - 1) * .04, .36, deck + .012), (.03, .012, .02), 'dark', bevel=0)
        a.box((.10 + (k - 1) * .04, .366, deck + .012), (.022, .002, .012), 'optic', bevel=0)
    a.box((0, .20, deck + .006), (.42, .012, .012), 'edge', bevel=.002)
    # Engine deck: louvred grilles, access panels with lifting handles, exhaust over the rear plate.
    for k in range(9):
        a.box((-.15, -.45 + k * .028, deck + .006), (.17, .012, .008), 'grille', bevel=0)
        a.box((.15, -.45 + k * .028, deck + .006), (.17, .012, .008), 'grille', bevel=0)
    for x in (-.15, .15):
        a.box((x, -.335, deck + .004), (.20, .30, .006), 'edge', bevel=.002)
        a.beam((x - .06, -.20, deck + .01), (x - .06, -.20, deck + .03), .004); a.beam((x + .06, -.20, deck + .01), (x + .06, -.20, deck + .03), .004)
    a.box((0, -.585, .27), (.30, .02, .06), 'grille', bevel=.003)
    # Rear stowage: two jerry cans and a track-section rack.
    for x in (-.24, .24):
        a.box((x, -.592, .19), (.07, .03, .10), 'paint', bevel=.006)
    if artillery:
        a.box((0, -.50, .17), (.48, .14, .10), 'steel', bevel=.004)
        a.cyl((-.22, -.53, .16), 'x', .027, .027, .44, 'dark', segs=10)
    # Turret ring race (visible when the turret is traversed).
    a.cyl((0, -.015, deck - .01), 'z', .215, .215, .022, 'dark', segs=28)
    save(a, ground_ao=.085)

# ======================================================================= turrets
def turret(name, kind=0):
    """kind 0 manned MBT turret, 1 remote-weapon unmanned turret, 2 howitzer cabin."""
    a = Asset(name)
    base = .335 if kind != 1 else .30
    top = base + (.165 if kind == 0 else .115 if kind == 1 else .23)
    a.cyl((0, -.015, base - .01), 'z', .205, .21, .03, 'dark', segs=28)
    if kind == 2:
        a.prism([(-.27, .20), (.27, .20), (.29, -.36), (-.29, -.36)], 'z', base + .02, top, 'paint', bevel=.01, inset=(.94, .94))
        a.box((0, .225, base + .14), (.24, .06, .16), 'edge', bevel=.008)
        a.cyl((0, .20, base + .135), 'y', .07, .07, .06, 'dark', segs=20)
        for s in (-1, 1):
            a.box((s * .292, -.08, base + .12), (.012, .22, .12), 'edge', bevel=.003)         # side ammo doors
            a.box((s * .21, -.36, top - .04), (.08, .05, .06), 'dark', bevel=.004)             # rear vents
        a.box((.12, -.10, top + .02), (.10, .12, .04), 'edge', bevel=.006)
        a.cyl((-.13, -.12, top), 'z', .05, .048, .03, 'edge', segs=16)
    else:
        # Wedge-armour plan outline with raked cheeks, swept sides and a long bustle.
        outline = [(-.12, .262), (.12, .262), (.275, .15), (.293, -.06), (.27, -.30), (.215, -.40), (-.215, -.40), (-.27, -.30), (-.293, -.06), (-.275, .15)]
        a.prism(outline, 'z', base + .015, top, 'paint', bevel=.012, inset=(.93, .95))
        # Add-on armour wedges over the cheeks.
        for s in (-1, 1):
            a.prism([(s * .13, .26), (s * .27, .155), (s * .20, .30)], 'z', base + .03, top - .02, 'edge', bevel=.006)
        # Mantlet around the trunnion (pivot at y .17, z .42).
        a.box((0, .235, .425), (.17, .07, .11), 'edge', bevel=.012)
        a.cyl((0, .20, .42), 'y', .055, .05, .09, 'dark', segs=20)
        if kind == 0:
            # Commander's cupola with vision blocks, loader's hatch with pintle machine gun.
            a.cyl((.115, -.12, top - .005), 'z', .075, .07, .035, 'edge', segs=20)
            for k in range(6):
                ang = k / 6 * math.tau
                a.box((.115 + math.cos(ang) * .072, -.12 + math.sin(ang) * .072, top + .015), (.02, .02, .016), 'optic', bevel=0)
            a.cyl((.115, -.12, top + .03), 'z', .062, .055, .014, 'paint', segs=20)
            a.cyl((-.12, -.08, top - .003), 'z', .06, .058, .014, 'edge', segs=18)
            a.beam((-.12, -.02, top + .01), (-.12, .02, top + .07), .006, 'dark')
            a.box((-.12, .03, top + .075), (.03, .07, .03), 'dark', bevel=.003)
            a.cyl((-.12, .065, top + .08), 'y', .006, .006, .13, 'dark', segs=6)
            a.box((-.12, .00, top + .07), (.012, .03, .045), 'dark', bevel=0)    # ammo box
            # Independent commander's panoramic sight on a mast.
            a.cyl((-.17, .05, top), 'z', .022, .022, .05, 'dark', segs=12)
            a.box((-.17, .05, top + .07), (.07, .06, .045), 'edge', bevel=.006)
            a.box((-.17, .081, top + .07), (.05, .004, .03), 'optic', bevel=0)
            # Gunner's primary sight with armoured doors.
            a.box((.16, .17, top + .025), (.08, .09, .06), 'edge', bevel=.008)
            a.box((.16, .216, top + .025), (.06, .004, .036), 'optic', bevel=0)
        else:
            # Unmanned turret: sensor mast and stabilised remote weapon station.
            a.box((0, -.20, top + .02), (.074, .08, .05), 'steel', bevel=.006)
            a.cyl((0, -.20, top + .045), 'z', .012, .012, .12, 'dark', segs=8)
            a.box((0, -.20, top + .17), (.07, .05, .05), 'edge', bevel=.006)
            a.box((0, -.174, top + .17), (.06, .003, .03), 'optic', bevel=0)
            a.box((.15, .04, top + .03), (.07, .10, .05), 'edge', bevel=.006)
            a.cyl((.15, .09, top + .035), 'y', .007, .007, .14, 'dark', segs=6)
        for s in (-1, 1):
            # Smoke grenade dischargers: four angled tubes per side.
            for k in range(4):
                a.cyl((s * (.20 + k * .018), .10 - k * .012, base + .12 + (k % 2) * .03), (s * .35, .9, .3), .014, .014, .06, 'dark', segs=8)
            # Bustle stowage boxes and lifting eyes.
            a.box((s * .26, -.30, base + .10), (.05, .16, .09), 'edge', bevel=.006)
            a.cyl((s * .22, .10, top + .005), (s, 0, 0), .012, .012, .012, 'steel', segs=8)
        # Rear bustle basket: welded rails.
        for z in (base + .09, base + .15):
            a.beam((-.24, -.43, z), (.24, -.43, z), .006); a.beam((-.24, -.43, z), (-.24, -.36, z), .006); a.beam((.24, -.43, z), (.24, -.36, z), .006)
        for x in (-.20, -.07, .07, .20):
            a.beam((x, -.43, base + .06), (x, -.43, base + .155), .005)
        a.box((0, -.405, base + .11), (.40, .04, .05), 'canvas', bevel=.01)     # rolled tarp in the basket
        # Two whip antennas on bases at the rear corners.
        for s in (-1, 1):
            a.cyl((s * .21, -.33, top), 'z', .012, .012, .02, 'dark', segs=8)
            a.beam((s * .21, -.33, top + .02), (s * .215, -.335, top + .30), .0025, 'dark')
    save(a, ground_ao=None)

# ======================================================================= gun barrels
def barrel(name, artillery=False):
    a = Asset(name)
    L = .86 if artillery else .68
    r = .041 if artillery else .031
    prof = [(0, 0), (r * 1.75, 0), (r * 1.75, .05), (r * 1.25, .07), (r * 1.25, .14),
            (r * 1.38, .15), (r * 1.38, .30), (r * 1.25, .31)]
    if artillery:
        prof += [(r * 1.2, .55), (r * 1.6, .56), (r * 1.6, .63), (r * 1.15, .64), (r * 1.1, L - .09)]
    else:
        prof += [(r * 1.25, .36), (r * 1.62, .38), (r * 1.62, .46), (r * 1.25, .48), (r * 1.18, .56), (r * 1.18, L - .06)]
    prof += [(r * 1.0, L - .06), (r, L)]
    a.lathe(prof, 'y', 'paint', segs=20)
    a.lathe([(r * .78, L - .001), (r * .7, L - .06)], 'y', 'dark', segs=20)          # bore
    # Thermal sleeve clamps.
    for t in (.17, .25, .52) if not artillery else (.20, .40):
        a.lathe([(r * 1.32, t), (r * 1.45, t + .004), (r * 1.45, t + .014), (r * 1.32, t + .018)], 'y', 'steel', segs=20)
    if artillery:
        # Double-baffle muzzle brake.
        a.box((0, L - .04, 0), (r * 3.4, .08, r * 2.0), 'dark', bevel=.006)
        for s in (-1, 1): a.box((s * r * 1.75, L - .04, 0), (.004, .05, r * 1.6), 'grille', bevel=0)
    else:
        a.box((0, L - .05, r * 1.25), (.012, .02, .012), 'dark', bevel=0)         # muzzle reference sensor
    save(a)

# ======================================================================= wheels
def road_wheel(name):
    a = Asset(name)
    w, R = .025, .084
    a.lathe([(0, -w), (R * .72, -w), (R * .80, -w * .92), (R * .80, w * .92), (R * .72, w), (0, w)], 'x', 'steel', segs=24)
    a.lathe([(R * .80, -w * .9), (R * .95, -w), (R, -w * .7), (R, w * .7), (R * .95, w), (R * .80, w * .9)], 'x', 'rubber', segs=24)
    a.lathe([(0, w + .006), (R * .3, w + .004), (R * .32, w)], 'x', 'dark', segs=16)
    a.lathe([(0, -w - .006), (R * .3, -w - .004), (R * .32, -w)], 'x', 'dark', segs=16)
    for k in range(6):
        ang = k / 6 * math.tau
        for s in (-1, 1):
            a.cyl((s * (w + .001), math.cos(ang) * R * .48, math.sin(ang) * R * .48), (s, 0, 0), .006, .005, .006, 'dark', segs=6, bevel=0)
    save(a)

def truck_wheel(name):
    a = Asset(name)
    w, R = .039, .106
    # Tyre carcass with sidewall bulge, then 18 chevron tread lugs.
    a.lathe([(R * .58, -w), (R * .80, -w * 1.02), (R * .93, -w * .95), (R * .985, -w * .7), (R * .985, w * .7), (R * .93, w * .95),
             (R * .80, w * 1.02), (R * .58, w)], 'x', 'rubber', segs=28)
    for k in range(18):
        ang = k / 18 * math.tau
        c, s_ = math.cos(ang), math.sin(ang)
        for side in (-1, 1):
            off = side * w * .38
            a.box((off, c * R * .99, s_ * R * .99), (w * .62, .016, .010), 'rubber', bevel=0)
    # Steel rim, centre-tyre-inflation hub and wheel nuts on the outer face.
    a.lathe([(0, w * .9), (R * .45, w * .85), (R * .58, w * .7), (R * .60, w), (R * .58, -w), (R * .45, -w * .8), (0, -w * .85)], 'x', 'steel', segs=24)
    a.lathe([(0, w * 1.25), (R * .18, w * 1.2), (R * .2, w * .9)], 'x', 'dark', segs=12)
    for k in range(8):
        ang = k / 8 * math.tau
        a.cyl((w * .9, math.cos(ang) * R * .32, math.sin(ang) * R * .32), 'x', .007, .006, .012, 'dark', segs=6, bevel=0)
    save(a)

# ======================================================================= wheeled armour and trucks
def carrier(name):
    """Eight-wheeled infantry carrier with a remote weapon station."""
    a = Asset(name)
    # Lower V-hull between the wheels, upper armoured body over them.
    a.prism([(-.49, .14), (-.49, .23), (.45, .23), (.50, .16), (.44, .09), (-.44, .09)], 'x', -.22, .22, 'paint', bevel=.008)
    a.prism([(-.50, .22), (-.50, .41), (.20, .425), (.47, .33), (.50, .25), (.48, .22)], 'x', -.30, .30, 'paint', bevel=.01)
    for s in (-1, 1):
        # Bolt-on armour panels along the flanks with stand-off gaps.
        for k in range(4):
            a.box((s * .307, -.38 + k * .22, .32), (.012, .20, .14), 'edge' if k % 2 else 'paint', bevel=.004)
        a.box((s * .26, .44, .31), (.05, .025, .026), 'dark', bevel=.003)
        a.box((s * .26, .452, .31), (.035, .004, .016), 'lamp', bevel=0)
        a.box((s * .27, -.505, .28), (.04, .006, .02), 'tail', bevel=0)
        a.beam((s * .30, .36, .40), (s * .36, .40, .42), .004, 'dark')                     # mirror arm
        a.box((s * .36, .40, .43), (.006, .03, .04), 'dark', bevel=0)
        for k in range(4):
            a.box((s * .262, -.38 + k * .245, .19), (.10, .12, .025), 'dark', bevel=.003)    # wheel arch liners
    # Driver's hatch and periscopes, troop roof hatches, rear ramp outline.
    a.cyl((.14, .24, .418), 'z', .05, .048, .016, 'edge', segs=16)
    for k in range(3): a.box((.14 + (k - 1) * .035, .29, .425), (.026, .012, .018), 'optic', bevel=0)
    for k in range(2): a.box((0, -.12 - k * .17, .418), (.30, .13, .014), 'edge', bevel=.003)
    a.box((0, -.508, .30), (.40, .008, .16), 'edge', bevel=.002)
    a.box((.18, -.513, .30), (.03, .006, .03), 'dark', bevel=0)
    # Remote weapon station: base, cradle, sight block and cannon.
    a.cyl((0, -.05, .425), 'z', .085, .08, .03, 'dark', segs=20)
    a.box((0, -.05, .48), (.13, .14, .07), 'edge', bevel=.01)
    a.box((.08, -.01, .49), (.05, .07, .05), 'dark', bevel=.005)
    a.box((.08, .022, .49), (.035, .003, .03), 'optic', bevel=0)
    a.cyl((-.02, .02, .48), 'y', .014, .012, .24, 'dark', segs=10)
    a.cyl((-.02, .24, .48), 'y', .018, .016, .02, 'dark', segs=10)
    for s in (-1, 1):
        for k in range(3): a.cyl((s * .07, -.10, .47 + k * .016), (s, -.3, .5), .009, .009, .04, 'dark', segs=6)
    a.beam((-.24, -.40, .41), (-.245, -.405, .66), .0025, 'dark')
    save(a, ground_ao=.09)

def armored_car(name):
    a = Asset(name)
    a.prism([(-.48, .15), (-.50, .24), (.30, .27), (.50, .20), (.46, .11), (-.44, .11)], 'x', -.24, .24, 'paint', bevel=.008)
    a.prism([(-.47, .24), (-.47, .33), (.20, .335), (.40, .27), (.40, .24)], 'x', -.30, .30, 'paint', bevel=.01, )
    for s in (-1, 1):
        a.box((s * .31, -.05, .29), (.03, .42, .07), 'edge', bevel=.006, taper=(1, .96))
        a.box((s * .33, -.33, .23), (.04, .14, .09), 'edge', bevel=.006)              # side stowage
        a.box((s * .24, .45, .245), (.05, .02, .025), 'dark', bevel=.003)
        a.box((s * .24, .461, .245), (.035, .004, .015), 'lamp', bevel=0)
        a.box((s * .25, -.48, .25), (.04, .006, .02), 'tail', bevel=0)
        a.box((s * .27, .17, .30), (.09, .006, .04), 'glass', bevel=0)
    # Armoured windscreen with louvred covers, driver vision block.
    a.box((0, .29, .30), (.36, .01, .045), 'glass', bevel=0)
    a.box((0, .30, .328), (.38, .02, .012), 'edge', bevel=.003)
    a.beam((-.20, -.42, .33), (-.205, -.425, .58), .0025, 'dark')
    a.beam((.20, -.42, .33), (.21, -.425, .52), .0025, 'dark')
    save(a, ground_ao=.09)

def cargo_truck(name, kind='cargo'):
    a = Asset(name)
    # Chassis rails and fuel tanks.
    for s in (-1, 1):
        a.box((s * .14, -.05, .13), (.04, .98, .05), 'dark', bevel=.003)
        a.cyl((s * .29, .05, .155), 'y', .045, .045, .16, 'steel', segs=14)
        a.box((s * .245, .48, .145), (.06, .03, .04), 'dark', bevel=.003)                 # bumper ends
    a.box((0, .49, .145), (.46, .03, .045), 'dark', bevel=.004)
    # Forward-control cab: sloped windscreen, armoured door panels, roof hatch, mirrors.
    a.prism([(.18, .16), (.18, .44), (.38, .44), (.47, .30), (.48, .16)], 'x', -.25, .25, 'sheet', bevel=.012)
    a.prism([(.39, .43), (.465, .31), (.468, .312), (.393, .432)], 'x', -.22, .22, 'glass', bevel=0)
    for s in (-1, 1):
        a.box((s * .252, .30, .35), (.004, .14, .08), 'glass', bevel=0)
        a.beam((s * .25, .43, .39), (s * .31, .45, .40), .004, 'dark')
        a.box((s * .315, .45, .38), (.006, .03, .06), 'dark', bevel=0)
        a.box((s * .21, .487, .21), (.05, .004, .025), 'lamp', bevel=0)
        a.box((s * .26, .30, .19), (.03, .14, .03), 'dark', bevel=.002)                   # step
    a.cyl((0, .31, .44), 'z', .05, .05, .014, 'dark', segs=16)
    a.box((0, .487, .30), (.30, .004, .05), 'grille', bevel=0)
    # Load bed.
    a.box((0, -.18, .19), (.50, .62, .02), 'sheet', bevel=.004)
    for s in (-1, 1): a.box((s * .245, -.18, .235), (.01, .62, .07), 'sheet', bevel=.002)
    a.box((0, -.49, .235), (.50, .01, .07), 'sheet', bevel=.002)
    for s in (-1, 1): a.box((s * .23, -.495, .175), (.04, .006, .02), 'tail', bevel=0)
    if kind == 'cargo':
        # Canvas canopy over five bows: slight sag between bows reads as fabric.
        pts = []
        for k in range(17):
            ang = math.pi * k / 16
            pts.append((math.cos(ang) * .245, .27 + math.sin(ang) * .21))
        a.prism(pts, 'y', -.485, .12, 'canvas', bevel=0)
        for k in range(5):
            y = -.45 + k * .14
            for j in range(16):
                a0 = math.pi * j / 16; a1 = math.pi * (j + 1) / 16
                a.beam((math.cos(a0) * .25, y, .27 + math.sin(a0) * .215), (math.cos(a1) * .25, y, .27 + math.sin(a1) * .215), .004, 'canvas')
        for s in (-1, 1):
            for k in range(5): a.beam((s * .248, -.46 + k * .14, .26), (s * .248, -.46 + k * .14, .29), .003, 'dark')   # tie-down straps
    elif kind == 'rocket':
        a.box((0, -.20, .27), (.46, .52, .14), 'edge', bevel=.008)
        for i in range(8):
            a.cyl(((i % 4 - 1.5) * .10, -.47, .29 + i // 4 * .068), 'y', .035, .035, .56, 'dark', segs=12)
            a.cyl(((i % 4 - 1.5) * .10, .095, .29 + i // 4 * .068), 'y', .025, .02, .01, 'paint', segs=12)
        a.box((0, -.20, .345), (.44, .50, .008), 'paint', bevel=.002)
    else:
        # Air defence: rotating radar dish on a mast and four ready missiles.
        a.cyl((0, -.20, .20), 'z', .16, .15, .10, 'paint', segs=20)
        a.box((0, -.21, .35), (.28, .06, .15), 'steel', bevel=.008)
        a.prism([(-.13, .42), (.13, .42), (.15, .52), (-.15, .52)], 'y', -.18, -.16, 'edge', bevel=.004)
        for i in range(4):
            x = (i - 1.5) * .09
            a.cyl((x, -.44, .32), (0, 1, .55), .03, .028, .26, 'edge', segs=10)
            a.cyl((x, -.44 + .23, .32 + .126), (0, 1, .55), .028, .002, .05, 'paint', segs=10)
    save(a, ground_ao=.075)

# ======================================================================= aircraft
def fighter(name, bomber=False):
    a = Asset(name)
    if bomber:
        # Blended flying wing: sawtooth trailing edge, low cockpit hump, buried intakes.
        plan = [(0, .62), (.78, -.12), (.80, -.20), (.60, -.15), (.42, -.32), (.22, -.18), (0, -.36),
                (-.22, -.18), (-.42, -.32), (-.60, -.15), (-.80, -.20), (-.78, -.12)]
        a.prism(plan, 'z', -.03, .02, 'paint', bevel=.012)
        a.prism([(0, .55), (.20, .05), (.13, -.25), (0, -.30), (-.13, -.25), (-.20, .05)], 'z', .02, .09, 'paint', bevel=.02, inset=(.7, .85))
        a.box((0, .33, .10), (.10, .10, .03), 'glass', bevel=.01, taper=(.7, .6))
        for s in (-1, 1):
            a.box((s * .14, .05, .11), (.10, .14, .03), 'dark', bevel=.008, taper=(.8, .7))
            a.box((s * .14, -.26, .04), (.12, .04, .02), 'grille', bevel=.004)
        save(a)
        return
    # Fuselage: lofted rings from radome to nozzle.
    rings = [(.0, .64), (.035, .58), (.06, .48), (.075, .35), (.085, .20), (.09, .05), (.09, -.20), (.085, -.38), (.07, -.50), (.065, -.56)]
    a.lathe([(r, y) for (r, y) in rings], 'y', 'paint', segs=16)
    a.lathe([(.062, -.50), (.07, -.57), (.055, -.60), (.04, -.58)], 'y', 'dark', segs=16)            # nozzle petals
    # Bubble canopy.
    a.lathe([(0, .44), (.04, .40), (.052, .30), (.05, .20), (.03, .12), (0, .10)], 'y', 'glass', segs=14, center=(0, 0, .065))
    # Chin intake.
    a.box((0, .16, -.085), (.11, .20, .07), 'paint', bevel=.012, taper=(.9, 1))
    a.box((0, .262, -.085), (.09, .006, .05), 'grille', bevel=0)
    for s in (-1, 1):
        # Cropped delta wing with leading-edge extension, missile rails, wingtip missiles.
        a.prism([(s * .08, .30), (s * .52, -.18), (s * .53, -.30), (s * .08, -.32)], 'z', -.012, .008, 'paint', bevel=.004)
        a.cyl((s * .535, .02, -.002), 'y', .012, .012, .30, 'edge', segs=8)
        a.cyl((s * .535, .32, -.002), 'y', .012, .001, .05, 'dark', segs=8)
        for k, x in enumerate((.22, .36)):
            a.box((s * x, -.08, -.03), (.008, .14, .02), 'dark', bevel=0)
            a.cyl((s * x, -.20, -.05), 'y', .016, .016, .26, 'edge', segs=8)
            a.cyl((s * x, .06, -.05), 'y', .016, .001, .05, 'dark', segs=8)
        # All-moving tailplanes.
        a.prism([(s * .07, -.38), (s * .27, -.52), (s * .27, -.58), (s * .07, -.56)], 'z', -.008, .006, 'paint', bevel=.003)
    # Fin with rudder line and antenna fairing.
    a.prism([(-.32, .07), (-.56, .07), (-.58, .24), (-.48, .24)], 'x', -.006, .006, 'paint', bevel=.003)
    a.box((0, -.52, .17), (.014, .06, .004), 'dark', bevel=0)
    save(a)

def helicopter(name):
    a = Asset(name)
    # Narrow armoured fuselage with stepped tandem cockpits.
    a.lathe([(0, .467), (.05, .45), (.09, .38), (.12, .25), (.13, .10), (.13, -.05), (.11, -.18), (.07, -.30), (.04, -.36)],
            'y', 'paint', segs=14, center=(0, 0, .14))
    a.prism([(.40, .18), (.33, .28), (.20, .30), (.16, .24), (.08, .33), (-.06, .33), (-.08, .22)], 'x', -.075, .075, 'glass', bevel=.004)
    a.box((0, .17, .33), (.15, .06, .01), 'paint', bevel=.003)       # canopy frame bar
    # Engine nacelles and exhaust suppressors either side of the mast.
    for s in (-1, 1):
        a.cyl((s * .12, -.10, .26), 'y', .05, .045, .22, 'paint', segs=14)
        a.cyl((s * .135, -.18, .27), 'y', .04, .045, .08, 'dark', segs=12)
        # Stub wings with a rocket pod and two missiles per side.
        # Wings root inside the fuselage flank (centre z .14, radius .13) at shoulder height.
        a.prism([(.10, .105), (.06, .125), (-.06, .125), (-.08, .105)], 'x', min(s * .08, s * .28), max(s * .08, s * .28), 'paint', bevel=.004)
        a.box((s * .24, 0, .09), (.012, .08, .03), 'dark', bevel=0)                     # outer pylon
        a.cyl((s * .24, -.10, .055), 'y', .036, .036, .20, 'edge', segs=12)
        a.cyl((s * .24, .10, .055), 'y', .036, .02, .03, 'edge', segs=12)
        a.lathe([(0, .101), (.03, .101)], 'y', 'dark', segs=12, center=(s * .24, 0, .055))
        a.box((s * .175, 0, .095), (.01, .06, .02), 'dark', bevel=0)                    # inner pylon
        for k in range(2):
            a.cyl((s * (.16 + k * .03), -.08, .07), 'y', .012, .012, .17, 'steel', segs=8)
        # Fixed landing gear.
        a.beam((s * .10, .20, .05), (s * .16, .22, -.03), .008, 'dark')
        a.cyl((s * .165 - .0125, .22, -.03), 'x', .025, .025, .025, 'rubber', segs=12)
    a.cyl((0, .10, .30), 'z', .05, .03, .03, 'dark', segs=14)                      # mast fairing up to the hub
    a.cyl((0, .08, .30), 'z', .018, .018, .02, 'dark', segs=10)
    # Nose sensor turret and chin cannon.
    a.lathe([(0, .52), (.045, .50), (.05, .46), (.04, .44)], 'y', 'dark', segs=12, center=(0, 0, .09))
    a.box((0, .503, .09), (.05, .004, .03), 'optic', bevel=0)
    a.cyl((0, .30, .02), 'z', .025, .02, .03, 'dark', segs=10)
    a.cyl((0, .30, .02), 'y', .008, .008, .14, 'dark', segs=6)
    # Tail boom, fin, tail rotor gearbox and horizontal stabiliser.
    a.cyl((0, -.30, .19), (0, -1, .14), .055, .028, .40, 'paint', segs=12)
    a.prism([(-.60, .22), (-.71, .22), (-.74, .42), (-.66, .42)], 'x', -.008, .008, 'paint', bevel=.003)
    a.cyl((.012, -.65, .28), 'x', .022, .02, .04, 'dark', segs=10)
    a.prism([(-.55, .23), (-.66, .23), (-.66, .24), (-.55, .24)], 'x', -.14, .14, 'paint', bevel=.002)
    a.box((0, -.71, .21), (.008, .03, .02), 'tail', bevel=0)
    save(a)

def rotor(name):
    a = Asset(name)
    a.cyl((0, 0, 0), 'z', .07, .05, .045, 'dark', segs=16)
    a.cyl((0, 0, .045), 'z', .03, .02, .02, 'steel', segs=12)
    for k in range(4):
        ang = k * math.pi / 2
        c, s = math.cos(ang), math.sin(ang)
        # Tapered, slightly twisted blade from root to tip.
        root, tip = .06, .59
        w0, w1 = .045, .032
        px, py = -s, c
        quad = [(c * root + px * w0 * .5, s * root + py * w0 * .5), (c * tip + px * w1 * .5, s * tip + py * w1 * .5),
                (c * tip - px * w1 * .5, s * tip - py * w1 * .5), (c * root - px * w0 * .5, s * root - py * w0 * .5)]
        a.prism(quad, 'z', .022, .030, 'dark', bevel=0)
        a.box((c * (tip - .02), s * (tip - .02), .026), (.04, .04, .009), 'edge', bevel=0)   # tip cap
    save(a, ao_rays=8)

# ======================================================================= small arms
def rifle(name):
    a = Asset(name)
    # Modern carbine: upper/lower receiver, free-float handguard, barrel, collapsible stock, curved magazine, optic.
    a.box((0, -.01, .005), (.032, .13, .045), 'polymer', bevel=.003)
    a.box((0, .095, .02), (.036, .11, .036), 'polymer', bevel=.004)
    for k in range(5): a.box((.019, .06 + k * .016, .02), (.002, .008, .016), 'dark', bevel=0)      # handguard slots
    a.cyl((0, .15, .022), 'y', .006, .006, .10, 'dark', segs=8)
    a.cyl((0, .245, .022), 'y', .01, .01, .012, 'dark', segs=8)                     # flash hider
    a.box((0, -.115, 0), (.026, .08, .04), 'polymer', bevel=.004, taper=(1, 1))
    a.box((0, -.155, -.01), (.032, .012, .06), 'dark', bevel=.003)                  # butt pad
    a.beam((0, -.075, .018), (0, -.11, .015), .005, 'dark')
    # Curved magazine.
    for k in range(4):
        a.box((0, .025 - k * .008, -.03 - k * .012), (.02, .028, .016), 'polymer', bevel=.002)
    a.box((0, -.05, -.035), (.02, .022, .05), 'polymer', bevel=.003)               # pistol grip
    a.box((0, -.027, -.022), (.006, .02, .004), 'dark', bevel=0)                    # trigger guard
    # Rail and reflex optic.
    a.box((0, .03, .033), (.014, .17, .006), 'dark', bevel=0)
    a.box((0, -.005, .05), (.022, .045, .028), 'dark', bevel=.004)
    a.box((0, .018, .05), (.016, .002, .02), 'optic', bevel=0)
    a.box((0, .115, .045), (.006, .01, .018), 'dark', bevel=0)                     # front sight
    save(a, ao_radius=.02, ao_rays=12)

tank_hull('Tank'); tank_hull('Autonomous', autonomous=True); tank_hull('Howitzer', artillery=True)
turret('Turret', 0); turret('RemoteTurret', 1); turret('HowitzerTurret', 2)
barrel('GunBarrel'); barrel('HowitzerBarrel', artillery=True)
road_wheel('RoadWheel'); truck_wheel('Wheel')
carrier('Carrier'); armored_car('ArmoredCar')
cargo_truck('CargoTruck', 'cargo'); cargo_truck('RocketTruck', 'rocket'); cargo_truck('AirDefense', 'radar')
fighter('Fighter'); fighter('Bomber', bomber=True)
helicopter('Helicopter'); rotor('Rotor')
rifle('Rifle')
with open(os.path.join(out, 'MANIFEST.txt'), 'w') as fh:
    fh.write('Built by tools/blender/build_military.py\n')
    for n, v, t in built: fh.write('%s %d %d\n' % (n, v, t))
print('[se] wrote %d models to %s' % (len(built), out))
