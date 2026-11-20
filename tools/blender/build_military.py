# Builds the close-range military models in Blender and writes them for Unity.
#   "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_military.py -- <out-dir>
# Units and pivots match Runtime/Rendering/MilitaryMeshes.cs (the code-built fallbacks): hulls stand on
# the origin facing +Y (Unity +Z); turrets turn about the vertical axis through the origin; barrels
# start at their trunnion and run along +Y; wheels are centred and roll about X; the main rotor sits on
# its hub at the origin. Every model is a real solid with chamfered edges and baked ambient occlusion.
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from se_meshkit import Asset
from mathutils import Vector

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

# Light 4x4 gun truck ("armored car"). The wheels are drawn by the client (the shared 'Wheel' model at 1.15x,
# centred at x +-CAR_TRACK, y +-CAR_AXLE, z CAR_WHEEL_Z); the roof-ring gun mount 'ArmoredCarMount' turns
# about the vertical axis through its origin, which the client places on the roof ring at (0, CAR_RING_Y, CAR_ROOF).
# Keep these in step with UnitRenderer.AddVehicle (Kind.ArmoredCar).
CAR_TRACK, CAR_AXLE, CAR_WHEEL_R, CAR_WHEEL_Z = .27, .31, .122, .12
CAR_ROOF, CAR_RING_Y, CAR_GUN_Z, CAR_MUZZLE_Y = .447, -.06, .145, .33

def _arch(cy, cz, r, z_cut, n=9):
    """Wheel-arch points (y, z) from the front cut through the top to the rear cut of a circle at (cy, cz)."""
    a0 = math.asin(max(-1., min(1., (z_cut - cz) / r)))
    return [(cy + math.cos(a0 + (math.pi - 2 * a0) * k / (n - 1)) * r, cz + math.sin(a0 + (math.pi - 2 * a0) * k / (n - 1)) * r)
            for k in range(n)]

def _gun_truck_body(a, lo=False):
    """lo: the operational-zoom version (no chamfers, no small fittings)."""
    R, ax, wz = CAR_WHEEL_R + .028, CAR_AXLE, CAR_WHEEL_Z
    low, b = .165, 0 if lo else 1
    # Wide, low tub with a long sloped hood and big wheel arches cut through it (the fender gaps).
    side = [(-.505, low), (-.515, .30), (.10, .305), (.44, .287), (.50, .252), (.508, .195), (.49, low)]
    side += _arch(ax, wz, R, low, 7 if lo else 9) + _arch(-ax, wz, R, low, 7 if lo else 9)
    a.prism(side, 'x', -.30, .30, 'paint', bevel=.008 * b)
    # Chassis, axles and diff housings under the tub: the ground clearance reads as a dark gap.
    a.box((0, 0, .148), (.36, .80, .045), 'dark', bevel=.004 * b)
    if not lo:
        for y in (ax, -ax):
            a.cyl((-.23, y, wz), 'x', .022, .022, .46, 'dark', segs=8, bevel=0)
            a.cyl((0, y, wz), 'y', .05, .05, .07, 'dark', segs=10)
    for s in (-1, 1):
        # Fender flares proud of the body over each wheel, and the rocker step between the arches.
        for y in (ax, -ax):
            outer = _arch(y, wz, R + .03, low - .02, 7 if lo else 9)
            inner = list(reversed(_arch(y, wz, R, low - .02, 7 if lo else 9)))
            a.prism(outer + inner, 'x', min(s * .295, s * .33), max(s * .295, s * .33), 'edge', bevel=.003 * b)
        a.box((s * .305, 0, .18), (.04, ax * 2 - R * 2 - .02, .03), 'dark', bevel=.003 * b)
        # Headlights in the grille corners, tail lights.
        a.box((s * .215, .503, .235), (.075, .02, .04), 'dark', bevel=.004 * b)
        a.box((s * .215, .514, .235), (.055, .004, .026), 'lamp', bevel=0)
        a.box((s * .25, -.517, .265), (.05, .008, .025), 'tail', bevel=0)
        # Four doors with armoured windows.
        xw = lambda z: .28 - .028 * (z - .295) / (CAR_ROOF - .295)      # the cab's sloped flank
        for y0, y1 in ((-.03, .07), (-.19, -.07)):
            a.prism([(s * (xw(.37) + .001), .37), (s * (xw(.425) + .001), .425), (s * (xw(.425) + .006), .425), (s * (xw(.37) + .006), .37)],
                    'y', y0, y1, 'glass', bevel=0)
            if lo: continue
            a.box((s * (xw(.33) + .003), (y0 + y1) / 2 - .01, .33), (.008, (y1 - y0) * .9, .045), 'edge', bevel=.002)
            a.box((s * (xw(.355) + .004), y1 - .025, .355), (.006, .025, .008), 'dark', bevel=0)
        if lo: continue
        for y in (.095, -.05):
            a.box((s * (xw(.37) + .002), y, .37), (.006, .006, .14), 'dark', bevel=0)
        # Mirror on an arm off the windscreen pillar; rear-corner whip antennas.
        a.beam((s * .27, .12, .33), (s * .345, .135, .345), .005, 'dark')
        a.box((s * .35, .135, .355), (.01, .035, .05), 'dark', bevel=.002)
        a.cyl((s * .25, -.47, .30), 'z', .012, .012, .025, 'dark', segs=8)
        a.beam((s * .25, -.47, .325), (s * .255, -.475, .66), .0028, 'dark')
    # Armoured cab: flanks leaning in, raked windscreen and back, flat roof with the gunner's ring.
    a.prism([(-.28, -.245), (.28, -.245), (.28, .152), (-.28, .152)], 'z', .295, CAR_ROOF, 'paint', bevel=.01 * b, inset=(.9, .8))
    d = Vector((-.0397, CAR_ROOF - .295)).normalized(); nrm = Vector((d.y, -d.x)) * .005
    for x0, x1 in ((-.235, -.014), (.014, .235)):
        p0 = Vector((.152, .295)) + d * .03; p1 = Vector((.152, .295)) + d * .145
        a.prism([tuple(p0), tuple(p1), tuple(p1 + nrm), tuple(p0 + nrm)], 'x', x0, x1, 'glass', bevel=0)
    a.cyl((0, CAR_RING_Y, CAR_ROOF - .004), 'z', .112, .112, .012, 'dark', segs=12 if lo else 20, bevel=.003 * b)
    # Hood: louvred engine vents; grille, bumper and brush guard.
    for k in range(5):
        a.box((0, .22 + k * .035, .298 - k * .002), (.20, .014, .012), 'grille', bevel=0)
    if lo:
        a.box((0, .507, .215), (.24, .012, .07), 'grille', bevel=0)
    else:
        for k in range(7):
            a.box(((k - 3) * .036, .507, .215), (.014, .012, .07), 'grille', bevel=0)
    a.box((0, .525, .17), (.60, .04, .05), 'dark', bevel=.005 * b)
    if not lo:
        for x in (-.11, .11):
            a.beam((x, .535, .19), (x, .53, .275), .007, 'dark')
        a.beam((-.11, .53, .27), (.11, .53, .27), .007, 'dark')
    # Rear deck: spare tyre laid flat, stowage boxes, jerry cans on the tailgate.
    a.cyl((0, -.385, .30), 'z', .095, .095, .045, 'rubber', segs=10 if lo else 16, bevel=.003 * b)
    a.cyl((0, -.385, .343), 'z', .055, .05, .006, 'steel', segs=8 if lo else 12, bevel=0)
    for s in (-1, 1):
        a.box((s * .2, -.36, .33), (.12, .2, .06), 'edge', bevel=.006 * b)
        a.box((s * .12, -.525, .22), (.08, .03, .11), 'paint', bevel=.006 * b)
    return a

def armored_car(name):
    a = Asset(name)
    _gun_truck_body(a)
    save(a, ground_ao=.09)

def armored_car_lo(name):
    """The whole gun truck in one mesh, wheels included, for the operational zoom (no per-wheel instances there)."""
    a = Asset(name)
    _gun_truck_body(a, lo=True)
    w, R = .045, CAR_WHEEL_R
    for sx in (-1, 1):
        for sy in (-1, 1):
            c = (sx * CAR_TRACK, sy * CAR_AXLE, CAR_WHEEL_Z)
            a.lathe([(R * .6, -w), (R, -w * .7), (R, w * .7), (R * .6, w)], 'x', 'rubber', segs=10, center=c)
            a.lathe([(0, -w * .8), (R * .6, -w * .8), (R * .6, w * .8), (0, w * .8)], 'x', 'steel', segs=8, center=c)
    save(a, ground_ao=.09)

def armored_car_mount(name):
    """Roof-ring weapon station: turntable, three-panel gunner's shield, heavy machine gun on a pintle and its gunner.
    Origin = ring centre on the roof; the gun points along +Y with its muzzle at (0, CAR_MUZZLE_Y, CAR_GUN_Z)."""
    a = Asset(name)
    g = CAR_GUN_Z
    a.cyl((0, 0, 0), 'z', .108, .10, .022, 'dark', segs=20)
    a.cyl((0, 0, .022), 'z', .09, .09, .01, 'edge', segs=20, bevel=0)
    # Shield: a broad front plate with a slot for the gun and two raked wings, all team-painted so the
    # weapon station reads (and turns) from the RTS camera.
    a.prism([(-.12, .02), (.12, .02), (.12, .195), (.026, .195), (.026, g - .022), (-.026, g - .022), (-.026, .195), (-.12, .195)],
            'y', .07, .088, 'paint', bevel=.003)
    for s in (-1, 1):
        a.prism([(s * .118, .088), (s * .185, .0), (s * .172, -.01), (s * .105, .074)], 'z', .02, .18, 'paint', bevel=.003)
    a.box((0, .072, .178), (.05, .004, .026), 'glass', bevel=0)
    # Pintle, cradle and the gun: receiver, barrel jacket, barrel, flash hider, ammo can, spade grips.
    a.beam((0, .03, .02), (0, .03, g - .02), .013, 'dark')
    a.box((0, .03, g), (.048, .16, .052), 'dark', bevel=.005)
    a.box((-.045, .04, g - .008), (.038, .075, .048), 'edge', bevel=.004)
    a.cyl((0, .11, g), 'y', .017, .017, .13, 'dark', segs=8)
    a.cyl((0, .24, g), 'y', .009, .009, .07, 'dark', segs=8, bevel=0)
    a.cyl((0, .305, g), 'y', .013, .012, CAR_MUZZLE_Y - .305, 'dark', segs=8)
    for x in (-.016, .016):
        a.beam((x, -.05, g), (x, -.075, g), .006, 'dark')
    # The gunner, standing in the ring behind his gun.
    a.ellipsoid((0, -.07, .10), (.052, .04, .07), 'cloth', segs=10, rings=6)
    a.ellipsoid((0, -.068, .185), (.026, .026, .03), 'skin', segs=8, rings=5)
    a.ellipsoid((0, -.07, .203), (.035, .037, .023), 'cloth2', segs=10, rings=5)
    for s in (-1, 1):
        a.limb((s * .047, -.065, .14), (s * .02, -.08, g), .014, .012, 'cloth', segs=6)
    save(a)

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
        # 2026-11-19: the chassis only. The launch pod is its own model (rocket_pod, RocketPod) hinged at
        # (0, -.46, .20) so it can lie flat for travel and raise to fire; UnitRenderer draws the stabiliser jacks.
        for s in (-1, 1):
            a.box((s * .20, -.46, .215), (.05, .07, .05), 'dark', bevel=.004)       # pod hinge brackets
            a.box((s * .27, -.47, .17), (.06, .06, .06), 'steel', bevel=.004)       # rear stabiliser housings
            a.box((s * .27, .12, .17), (.06, .06, .06), 'steel', bevel=.004)        # forward stabiliser housings
        a.box((0, .02, .215), (.30, .04, .03), 'dark', bevel=.003)                    # travel rest under the pod's nose
        a.cyl((0, -.30, .20), 'z', .045, .045, .05, 'steel', segs=12)                 # elevation ram mount
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

def rocket_pod(name):
    # The missile battery's launch pod about its hinge (origin; on the chassis at (0, -.46, .20)): eight tubes
    # along +Y with their caps at the front; UnitRenderer raises it about X to fire.
    a = Asset(name)
    a.box((0, .26, .07), (.46, .52, .14), 'edge', bevel=.008)
    for i in range(8):
        a.cyl(((i % 4 - 1.5) * .10, -.01, .09 + i // 4 * .068), 'y', .035, .035, .56, 'dark', segs=12)
        a.cyl(((i % 4 - 1.5) * .10, .555, .09 + i // 4 * .068), 'y', .025, .02, .01, 'paint', segs=12)
    a.box((0, .26, .145), (.44, .50, .008), 'paint', bevel=.002)
    a.cyl((0, .16, 0), 'z', .03, .03, .02, 'steel', segs=10)                       # elevation ram eye
    save(a, ground_ao=None)

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

def warthog(name):
    """The Warthog ground-attack jet (unit 'fighter'): straight low wing, twin engine pods on the rear
    fuselage, twin fins at the tips of the tailplane, the 30 mm rotary cannon jutting from under the nose,
    blunt canopy well forward, wing-root gear pods and underwing stores."""
    a = Asset(name)
    # Fuselage: a long slab-sided tube from the gun nose back to the tail cone.
    rings = [(.0, .57), (.035, .55), (.06, .49), (.074, .40), (.08, .26), (.08, .02), (.074, -.18), (.062, -.34), (.046, -.46), (.03, -.54), (.0, -.57)]
    a.lathe(rings, 'y', 'paint', segs=16)
    # GAU-8 barrels out of the nose, slightly left of centre and low, with the muzzle cluster.
    a.cyl((-.012, .50, -.035), 'y', .016, .016, .13, 'dark', segs=10)
    for k in range(4):
        ang = k * math.pi / 2
        a.cyl((-.012 + math.cos(ang) * .008, .60, -.035 + math.sin(ang) * .008), 'y', .0035, .0035, .04, 'steel', segs=6)
    # Blunt canopy close to the nose.
    a.lathe([(0, .44), (.03, .42), (.042, .36), (.042, .28), (.03, .23), (0, .21)], 'y', 'glass', segs=14, center=(0, 0, .06))
    a.box((0, .33, .093), (.07, .006, .02), 'paint', bevel=.002)          # canopy bow
    for s in (-1, 1):
        # Straight, thick, low-set wing with a slight taper; drooped wingtips.
        a.prism([(s * .07, .11), (s * .50, .075), (s * .50, -.055), (s * .07, -.085)], 'z', -.055, -.030, 'paint', bevel=.004)
        a.prism([(s * .50, .075), (s * .58, .06), (s * .58, -.045), (s * .50, -.055)], 'z', -.062, -.040, 'edge', bevel=.003)
        # Main gear pods under the wing roots.
        a.box((s * .15, .04, -.075), (.055, .17, .045), 'paint', bevel=.012, taper=(1, .9))
        # Underwing pylons and stores: missiles outboard, bombs and a rocket pod inboard.
        for k, x in enumerate((.24, .32, .40, .47)):
            a.box((s * x, .01, -.065), (.01, .07, .02), 'dark', bevel=0)
            if k == 3:
                a.cyl((s * x, -.06, -.085), 'y', .012, .012, .15, 'edge', segs=8)
                a.cyl((s * x, .09, -.085), 'y', .012, .001, .035, 'dark', segs=8)
            else:
                a.cyl((s * x, -.07, -.09), 'y', .022, .022, .15, 'edge' if k else 'dark', segs=10)
                a.cyl((s * x, .08, -.09), 'y', .022, .004, .04, 'dark', segs=10)
        # Engine pods high on the rear fuselage, on short stub pylons, with dark intakes and exhausts.
        x = s * .125
        a.box((s * .075, -.25, .065), (.05, .14, .045), 'paint', bevel=.008)
        a.cyl((x, -.09, .11), (0, -1, 0), .058, .056, .30, 'paint', segs=16)
        a.cyl((x, -.083, .11), (0, -1, 0), .05, .05, .008, 'grille', segs=16)
        a.cyl((x, -.39, .11), (0, -1, 0), .05, .042, .05, 'dark', segs=14)
        # Tailplane and the twin fins at its tips.
        a.prism([(s * .03, -.43), (s * .27, -.45), (s * .27, -.55), (s * .03, -.56)], 'z', .010, .024, 'paint', bevel=.003)
        fx = s * .27
        a.prism([(-.42, -.02), (-.56, -.02), (-.58, .17), (-.49, .17)], 'x', fx - .007, fx + .007, 'paint', bevel=.003)
        a.box((fx, -.55, .08), (.016, .02, .02), 'tail' if s < 0 else 'optic', bevel=0)
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
carrier('Carrier'); armored_car('ArmoredCar'); armored_car_lo('ArmoredCarLo'); armored_car_mount('ArmoredCarMount')
cargo_truck('CargoTruck', 'cargo'); cargo_truck('RocketTruck', 'rocket'); rocket_pod('RocketPod'); cargo_truck('AirDefense', 'radar')
fighter('Fighter'); fighter('Bomber', bomber=True); warthog('Warthog')
helicopter('Helicopter'); rotor('Rotor')
rifle('Rifle')
with open(os.path.join(out, 'MANIFEST.txt'), 'w') as fh:
    fh.write('Built by tools/blender/build_military.py\n')
    for n, v, t in built: fh.write('%s %d %d\n' % (n, v, t))
print('[se] wrote %d models to %s' % (len(built), out))
