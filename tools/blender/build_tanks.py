# Stylized tanks (2026-11-20 tank pass, user: "Replace the tank model with a more stylized, more obvious one"):
# chunky, readable silhouettes for the RTS camera rather than fine realistic detail.
#   "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_tanks.py -- <out-dir>
# (build_military.py also builds these through build_all, so a full military rebuild keeps them.)
#
# Pivots and units follow build_military.py and UnitRenderer.AddVehicle: hulls stand on the origin facing +Y (Unity +Z)
# and are drawn .64 wide x 1.12 long (true proportions) on the renderer's own tracks (links at x +-.434, road wheels at
# x +-.432, y .106); turrets turn about the vertical axis through the origin and are drawn .8 wide; the barrel starts at
# its trunnion, (0, .17, .42) in turret space for the tank and (0, .17, .362) for the autonomous tank, and runs along +Y.
#
# Each tank has two extra "trim" meshes drawn over the hull and the turret with the TEAM colour (UnitRenderer):
# TankTrim / TurretTrim (manned tank: bold skirt bands, a glacis chevron, turret flank panels and a roof plate) and
# AutoTrim / RemoteTrim (autonomous tank: light strips, drawn emissive, with cyan sensor lenses). Trim parts sit a few
# millimetres proud of the surface they decorate so they never z-fight.
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from se_meshkit import Asset

# ======================================================================= shared running gear
def _running_gear(a, autonomous):
    for s in (-1, 1):
        # drive sprocket (rear) and idler (front) inside the renderer's track loop
        a.lathe([(0, -.032), (.092, -.032), (.104, -.02), (.104, .02), (.092, .032), (0, .032)], 'x', 'dark', segs=16, center=(s * .434, -.40, .13))
        for t in range(8):
            ang = t / 8 * math.tau
            a.box((s * .434, -.40 + math.cos(ang) * .108, .13 + math.sin(ang) * .108), (.05, .022, .022), 'dark', bevel=0)
        a.lathe([(0, -.03), (.09, -.03), (.096, -.02), (.096, .02), (.09, .03), (0, .03)], 'x', 'steel', segs=16, center=(s * .434, .41, .14))

# ======================================================================= main battle tank
def tank_hull(save):
    a = Asset('Tank')
    deck = .34
    # Lower hull: a big wedge with a long, steep upper glacis (the silhouette reads "tank" from any angle).
    a.prism([(-.56, .09), (-.585, .30), (-.55, deck), (.10, deck), (.55, .215), (.57, .15), (.51, .08), (-.50, .08)],
            'x', -.30, .30, 'paint', bevel=.016)
    for s in (-1, 1):
        x0, x1 = (.30, .475) if s > 0 else (-.475, -.30)
        # fenders over the tracks, raked at the front
        a.prism([(-.585, .262), (-.585, deck - .006), (.40, deck - .006), (.57, .272), (.55, .262)], 'x', x0, x1, 'paint', bevel=.012)
        # one chunky full-length skirt per side, chamfered at the front, with three deep panel grooves
        sx0, sx1 = (.475, .515) if s > 0 else (-.515, -.475)
        a.prism([(-.555, .15), (-.555, .318), (.43, .318), (.545, .225), (.51, .15)], 'x', sx0, sx1, 'paint', bevel=.012)
        for y in (-.30, -.05, .20):
            a.box((s * .518, y, .235), (.008, .014, .15), 'dark', bevel=0)
        # big stowage bins on the fenders and a fuel drum at the rear
        a.box((s * .385, -.16, deck + .035), (.15, .36, .07), 'edge', bevel=.014)
        a.box((s * .385, -.16, deck + .072), (.12, .30, .006), 'dark', bevel=0)
        a.cyl((s * .385, -.53, deck + .045), 'x', .045, .045, .15, 'edge', segs=14, bevel=.006)
        # headlight block with a bright lens; tail light
        a.box((s * .37, .46, deck - .02), (.075, .05, .045), 'dark', bevel=.006)
        a.box((s * .37, .487, deck - .02), (.05, .006, .026), 'lamp', bevel=0)
        a.box((s * .38, -.592, .30), (.05, .008, .026), 'tail', bevel=0)
        # tow hooks
        a.box((s * .19, .555, .13), (.05, .03, .04), 'steel', bevel=.006)
    _running_gear(a, False)
    # driver's hatch and periscopes, set into the glacis
    a.cyl((.10, .16, deck - .004), 'z', .065, .06, .022, 'edge', segs=16, bevel=.004)
    a.box((.10, .235, deck + .006), (.09, .016, .022), 'optic', bevel=.003)
    # engine deck: two bold louvred grilles in raised frames, and twin exhausts over the rear plate
    for x in (-.14, .14):
        a.box((x, -.37, deck + .008), (.20, .30, .016), 'edge', bevel=.006)
        for k in range(6):
            a.box((x, -.49 + k * .048, deck + .018), (.17, .024, .008), 'grille', bevel=0)
    for x in (-.12, .12):
        a.box((x, -.595, .25), (.10, .018, .05), 'grille', bevel=.004)
    # turret ring
    a.cyl((0, -.03, deck - .01), 'z', .235, .235, .022, 'dark', segs=24)
    save(a, ground_ao=.085)

def tank_trim(save):
    a = Asset('TankTrim')
    for s in (-1, 1):
        # a bold team band along each skirt, a plate on each stowage bin and a chevron arm on the glacis
        a.box((s * .5205, -.06, .258), (.006, .84, .075), 'trim', bevel=.002)
        a.box((s * .385, -.16, .34 + .0735), (.10, .26, .003), 'trim', bevel=0)
        _glacis_strip(a, s)
    # rear plate band
    a.box((0, -.5885, .20), (.40, .006, .04), 'trim', bevel=.002)
    save(a, ao_rays=6)

def _glacis_strip(a, s):
    """One arm of the glacis chevron: a quad strip on the upper glacis plane from the centre-front out and back."""
    import bmesh
    from mathutils import Vector
    y0, z0, y1, z1 = .10, .34, .55, .215          # glacis line (side profile)
    def on(y, x, lift=.004):
        t = (y - y0) / (y1 - y0)
        z = z0 + (z1 - z0) * t
        ny, nz = (z0 - z1), (y1 - y0)
        L = math.hypot(ny, nz); ny /= L; nz /= L
        return Vector((x, y + ny * lift, z + nz * lift))
    w = .045
    pts = [on(.46, 0), on(.46 - w, 0), on(.28 - w, s * .20), on(.28, s * .20)]
    pts2 = [on(.46, 0, .009), on(.46 - w, 0, .009), on(.28 - w, s * .20, .009), on(.28, s * .20, .009)]
    before = set(a.bm.faces)
    b = [a.bm.verts.new(p) for p in pts]; t = [a.bm.verts.new(p) for p in pts2]
    a.bm.faces.new(b); a.bm.faces.new(list(reversed(t)))
    for i in range(4):
        j = (i + 1) % 4
        a.bm.faces.new((b[j], b[i], t[i], t[j]))
    faces = [f for f in a.bm.faces if f not in before]
    bmesh.ops.recalc_face_normals(a.bm, faces=faces)
    a._finish(faces, 'trim', 0)

TANK_TURRET = [(-.15, .31), (.15, .31), (.32, .18), (.345, -.05), (.32, -.30), (.25, -.45), (-.25, -.45), (-.32, -.30), (-.345, -.05), (-.32, .18)]

def tank_turret(save):
    a = Asset('Turret')
    base, top = .345, .535
    a.cyl((0, -.03, base - .012), 'z', .225, .23, .03, 'dark', segs=24)
    # a big, angular wedge turret with a long bustle
    a.prism(TANK_TURRET, 'z', base, top, 'paint', bevel=.018, inset=(.90, .94))
    for s in (-1, 1):
        # thick add-on cheek armour blocks
        a.prism([(s * .15, .30), (s * .31, .18), (s * .26, .345)], 'z', base + .02, top - .015, 'edge', bevel=.01)
        # three chunky smoke dischargers per side
        for k in range(3):
            a.cyl((s * (.25 + k * .025), .14 - k * .02, top - .03), (s * .4, .8, .45), .02, .02, .07, 'dark', segs=10)
        # bustle stowage
        a.box((s * .27, -.33, base + .085), (.06, .20, .10), 'edge', bevel=.01)
    # mantlet and the gun's sleeve (trunnion at y .17, z .42); coaxial machine gun to the gun's right
    a.box((0, .315, .42), (.24, .09, .15), 'edge', bevel=.022)
    a.cyl((0, .33, .42), 'y', .066, .06, .08, 'dark', segs=18)
    a.box((.105, .345, .395), (.045, .05, .04), 'dark', bevel=.006)
    a.cyl((.105, .37, .395), 'y', .011, .011, .07, 'dark', segs=8)
    # commander's cupola (big, with a ring of glass) and a roof heavy machine gun
    a.cyl((.14, -.13, top - .004), 'z', .09, .082, .045, 'edge', segs=18, bevel=.006)
    for k in range(6):
        ang = k / 6 * math.tau
        a.box((.14 + math.cos(ang) * .086, -.13 + math.sin(ang) * .086, top + .02), (.026, .026, .02), 'optic', bevel=0)
    a.cyl((.14, -.13, top + .041), 'z', .07, .06, .016, 'paint', segs=18, bevel=.004)
    a.box((-.13, -.05, top + .05), (.035, .10, .04), 'dark', bevel=.005)
    a.cyl((-.13, .00, top + .055), 'y', .009, .009, .17, 'dark', segs=8)
    a.beam((-.13, -.07, top), (-.13, -.06, top + .035), .008, 'dark')
    # gunner's sight: an armoured box with a large lens
    a.box((-.16, .19, top + .03), (.10, .10, .07), 'edge', bevel=.012)
    a.box((-.16, .242, top + .03), (.075, .005, .042), 'optic', bevel=0)
    # loader's hatch
    a.cyl((-.08, -.22, top - .002), 'z', .065, .062, .016, 'edge', segs=16, bevel=.004)
    # bustle basket rail and a tall whip antenna
    a.box((0, -.47, base + .10), (.46, .05, .07), 'canvas', bevel=.014)
    for x in (-.22, .22):
        a.beam((x, -.45, base + .06), (x, -.50, base + .15), .007, 'dark')
    a.cyl((.24, -.36, top), 'z', .014, .014, .025, 'dark', segs=8)
    a.beam((.24, -.36, top + .025), (.245, -.37, top + .36), .003, 'dark')
    save(a, ground_ao=None)

def turret_trim(save):
    a = Asset('TurretTrim')
    base, top = .345, .535
    # flank panels: thin slabs leaning with the turret's sloped sides (x .345 at the base -> .31 at the roof)
    for s in (-1, 1):
        z0, z1 = .37, .51
        def x_at(z): return .345 - (.345 * (1 - .90)) * (z - base) / (top - base)
        a.prism([(s * (x_at(z0) + .001), z0), (s * (x_at(z0) + .008), z0), (s * (x_at(z1) + .008), z1), (s * (x_at(z1) + .001), z1)],
                'y', -.26, .06, 'trim', bevel=0)
    # roof plate: a bold square on the bustle roof, and a stripe across the bustle rear
    a.box((0, -.30, top + .003), (.22, .16, .004), 'trim', bevel=0)
    a.box((0, -.4475 + .028, base + .05), (.34, .006, .035), 'trim', bevel=0)
    save(a, ao_rays=6)

def tank_barrel(save):
    a = Asset('GunBarrel')
    L, r = .80, .040
    prof = [(0, 0), (r * 1.8, 0), (r * 1.8, .06), (r * 1.3, .08), (r * 1.3, .40), (r * 1.62, .43), (r * 1.62, .53), (r * 1.25, .56),
            (r * 1.12, L - .09), (r * 1.0, L - .09), (r * .95, L)]
    a.lathe(prof, 'y', 'paint', segs=16)
    a.lathe([(r * .72, L - .001), (r * .66, L - .05)], 'y', 'dark', segs=16)
    for t in (.16, .30):
        a.lathe([(r * 1.36, t), (r * 1.5, t + .006), (r * 1.5, t + .02), (r * 1.36, t + .026)], 'y', 'steel', segs=16)
    # a big, unmistakable muzzle brake
    a.box((0, L - .045, 0), (r * 3.4, .09, r * 2.2), 'dark', bevel=.008)
    for s in (-1, 1):
        a.box((s * r * 1.72, L - .045, 0), (.006, .06, r * 1.6), 'grille', bevel=0)
    save(a)

# ======================================================================= autonomous tank
def auto_hull(save):
    a = Asset('Autonomous')
    deck = .30
    # low, sleek, faceted: a long knife-edge glacis, a raked rear, a narrow upper deck over wide chamfered flanks
    a.prism([(-.55, .09), (-.585, .25), (-.52, deck), (.06, deck), (.57, .19), (.58, .145), (.52, .08), (-.50, .08)],
            'x', -.30, .30, 'paint', bevel=.012)
    for s in (-1, 1):
        x0, x1 = (.30, .48) if s > 0 else (-.48, -.30)
        a.prism([(-.585, .245), (-.55, deck - .01), (.36, deck - .01), (.585, .21), (.56, .2)], 'x', x0, x1, 'paint', bevel=.01)
        # faceted armour skirt: a lower vertical plate and an upper plate chamfered inward
        sx0, sx1 = (.48, .512) if s > 0 else (-.512, -.48)
        a.prism([(-.56, .15), (-.56, .25), (.47, .25), (.565, .19), (.53, .15)], 'x', sx0, sx1, 'paint', bevel=.01)
        ux0, ux1 = (.47, .505) if s > 0 else (-.505, -.47)
        a.prism([(-.53, .25), (-.50, .29), (.40, .29), (.50, .25)], 'x', ux0, ux1, 'edge', bevel=.008)
        a.box((s * .515, .05, .20), (.006, .86, .012), 'dark', bevel=0)              # skirt seam
        # sensor pods at the front corners and rear corners (lenses in AutoTrim)
        a.box((s * .36, .47, deck - .055), (.09, .07, .05), 'dark', bevel=.012)
        a.box((s * .40, -.56, .27), (.07, .05, .04), 'dark', bevel=.01)
        # active-protection launcher boxes on the flanks
        a.box((s * .40, .15, deck + .02), (.10, .16, .04), 'edge', bevel=.01)
    _running_gear(a, True)
    # power-pack deck: a single sleek armoured cowl with cooling slits
    a.box((0, -.36, deck + .012), (.44, .32, .024), 'edge', bevel=.008)
    for k in range(5):
        a.box((0, -.47 + k * .055, deck + .026), (.36, .014, .006), 'grille', bevel=0)
    # sensor bar across the glacis
    a.box((0, .36, .262), (.34, .035, .03), 'dark', bevel=.008)
    a.cyl((0, -.03, deck - .01), 'z', .22, .22, .02, 'dark', segs=24)
    save(a, ground_ao=.085)

def auto_trim(save):
    a = Asset('AutoTrim')
    deck = .30
    for s in (-1, 1):
        # long light strips along the skirts and the fender edges
        a.box((s * .516, .02, .225), (.005, .90, .016), 'trim', bevel=0)
        a.box((s * .40, .02, deck + .002), (.012, .50, .004), 'trim', bevel=0)
        # sensor lenses on the corner pods
        a.box((s * .36, .506, deck - .055), (.06, .004, .022), 'glow', bevel=0)
        a.box((s * .40, -.587, .27), (.045, .004, .016), 'glow', bevel=0)
        # chevron light on the active-protection boxes
        a.box((s * .40, .15, deck + .0415), (.07, .10, .003), 'trim', bevel=0)
    # the glacis sensor bar's light line and a rear light bar
    a.box((0, .3785, .262), (.30, .004, .012), 'glow', bevel=0)
    a.box((0, -.5875, .21), (.36, .004, .014), 'trim', bevel=0)
    save(a, ao_rays=6)

AUTO_TURRET = [(-.10, .36), (.10, .36), (.28, .17), (.30, -.10), (.25, -.37), (-.25, -.37), (-.30, -.10), (-.28, .17)]

def auto_turret(save):
    a = Asset('RemoteTurret')
    base, top = .305, .43
    a.cyl((0, -.03, base - .01), 'z', .215, .22, .026, 'dark', segs=24)
    # a low faceted unmanned turret: an arrowhead plan with steeply raked walls
    a.prism(AUTO_TURRET, 'z', base, top, 'paint', bevel=.014, inset=(.84, .9))
    a.prism([(-.17, .02), (.17, .02), (.20, -.30), (-.20, -.30)], 'z', top - .002, top + .03, 'edge', bevel=.01, inset=(.9, .9))
    # slim mantlet around the gun (trunnion at y .17, z .362)
    a.box((0, .31, .362), (.15, .08, .09), 'edge', bevel=.016)
    a.cyl((0, .34, .362), 'y', .05, .045, .06, 'dark', segs=16)
    # twin coaxial machine guns in armoured pods either side of the gun
    for s in (-1, 1):
        a.box((s * .12, .30, .345), (.05, .10, .045), 'dark', bevel=.008)
        a.cyl((s * .12, .35, .345), 'y', .01, .01, .08, 'dark', segs=8)
    # sensor mast: a tall pole with a big rotating sensor head (its eye glows in RemoteTrim)
    a.cyl((-.15, -.20, top + .03), 'z', .022, .016, .17, 'dark', segs=10)
    a.box((-.15, -.20, top + .23), (.10, .08, .06), 'edge', bevel=.014)
    a.box((-.15, -.20, top + .27), (.05, .05, .02), 'dark', bevel=.006)
    # a remote weapon station with its sight on the right of the roof
    a.box((.15, -.06, top + .05), (.08, .12, .05), 'edge', bevel=.01)
    a.cyl((.15, .00, top + .055), 'y', .008, .008, .15, 'dark', segs=8)
    # radar / jammer panels on the rear corners
    for s in (-1, 1):
        a.box((s * .21, -.31, base + .07), (.05, .10, .08), 'dark', bevel=.01)
    save(a, ground_ao=None)

def remote_trim(save):
    a = Asset('RemoteTrim')
    base, top = .305, .43
    # the mast's sensor eye (front) and the RWS sight lens
    a.box((-.15, -.157, top + .23), (.07, .004, .03), 'glow', bevel=0)
    a.box((.15, .0025, top + .05), (.05, .004, .02), 'glow', bevel=0)
    # gun-pod lenses
    for s in (-1, 1):
        a.box((s * .12, .3515, .37), (.03, .003, .01), 'glow', bevel=0)
    # team light lines along the turret's upper edge (inset .84 x / .9 y at the roof)
    pts = [(x * .84, y * .9 + (1 - .9) * (-.0175)) for (x, y) in AUTO_TURRET]
    for i in range(len(pts)):
        p0, p1 = pts[i], pts[(i + 1) % len(pts)]
        if p0[1] < -.2 and p1[1] < -.2: continue   # not across the rear
        a.beam((p0[0], p0[1], top + .002), (p1[0], p1[1], top + .002), .006, 'trim')
    # a team plate on the raised roof deck
    a.box((0, -.17, top + .0305), (.18, .12, .003), 'trim', bevel=0)
    save(a, ao_rays=6)

def auto_barrel(save):
    a = Asset('AutoBarrel')
    L, r = .92, .034
    prof = [(0, 0), (r * 1.9, 0), (r * 1.9, .05), (r * 1.25, .07), (r * 1.25, L - .14), (r * 1.6, L - .13), (r * 1.6, L - .02), (r * 1.1, L)]
    a.lathe(prof, 'y', 'paint', segs=12)
    a.lathe([(r * .72, L - .001), (r * .6, L - .05)], 'y', 'dark', segs=12)
    # cooling collars along the tube
    for t in (.14, .26, .38, .50, .62):
        a.lathe([(r * 1.3, t), (r * 1.48, t + .006), (r * 1.48, t + .03), (r * 1.3, t + .036)], 'y', 'dark', segs=12)
    # an angular muzzle shroud
    a.box((0, L - .075, 0), (r * 3.2, .07, r * 2.4), 'edge', bevel=.008, taper=(.8, 1))
    save(a)

def build_all(save):
    tank_hull(save); tank_trim(save); tank_turret(save); turret_trim(save); tank_barrel(save)
    auto_hull(save); auto_trim(save); auto_turret(save); remote_trim(save); auto_barrel(save)

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(os.getcwd(), 'out')
    os.makedirs(out, exist_ok=True)
    built = []
    def save(a, **kw):
        v, t = a.export(os.path.join(out, a.name + '.bytes'), **kw)
        built.append((a.name, v, t))
        print('[se] %-18s %6d verts %6d tris' % (a.name, v, t))
    build_all(save)
    with open(os.path.join(out, 'TANK_MANIFEST.txt'), 'w') as fh:
        fh.write('Built by tools/blender/build_tanks.py\n')
        for n, v, t in built: fh.write('%s %d %d\n' % (n, v, t))
    print('[se] wrote %d tank models to %s' % (len(built), out))
