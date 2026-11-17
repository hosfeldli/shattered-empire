# Shattered Empires — rigged, animated infantry, baked for GPU instancing.
#
#   live (Blender MCP):  exec(open(r"<repo>/tools/blender/build_soldiers.py").read(), {"__name__": "__main__", "SE_OUT": r"<models dir>"})
#   headless:            "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_soldiers.py -- <models dir>
#
# Seven role variants share one skeleton. Arms are solved with IK onto the weapon's grips and legs with IK
# onto animated foot targets, so hands stay on the weapon and feet plant. Clips (30 fps, one timeline):
#   idle 0-59 · walk 61-90 · run 92-111 · aim 113-152 · fire 154-159 · die 161-200
#   kneel 203-242 (kneeling, shouldered: cover and mortar spotters) · hop 244-259 (a short step-down into
#   a trench) · deploy 261-308 (kneeling over the weapon, working it: a mortar crew assembling and loading)
#   (one spare frame after each)
# For each role the script writes, into the models directory:
#   Soldier<r>.bytes      SEM1 rest mesh; uv0.x = deform bone index (every part is rigid to one bone)
#   SoldierAnim<r>.bytes  SEA1: per frame, per deform bone, the 3x4 skinning matrix in Unity space
# The game's instanced shader reads the matrix for each soldier's frame, so thousands animate in one draw.
import bpy, sys, os, math, struct, importlib

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else r"D:/Projects/shattered_empires/tools/blender"
sys.path.insert(0, HERE)
import se_meshkit; importlib.reload(se_meshkit)
from se_meshkit import Asset, PAL, FABRIC, PLAIN
from mathutils import Vector, Matrix

if 'SE_OUT' in globals(): OUT = SE_OUT
elif '--' in sys.argv: OUT = sys.argv[sys.argv.index('--') + 1]
else: OUT = os.path.join(os.getcwd(), 'out')
os.makedirs(OUT, exist_ok=True)

ROLES = ['Rifleman', 'Engineer', 'Militia', 'SpecialForces', 'Exo', 'AntiArmor', 'MortarCrew']
WEAPON = {0: 'rifle', 1: 'pistol', 2: 'ak', 3: 'carbine', 4: 'rifle', 5: 'launcher', 6: 'carbine'}
DEFORM = ['hips', 'chest', 'head', 'upperarm.L', 'forearm.L', 'upperarm.R', 'forearm.R',
          'thigh.L', 'shin.L', 'foot.L', 'thigh.R', 'shin.R', 'foot.R', 'weapon']
SIDES = (('L', -1), ('R', 1))       # facing +Y with Z up, the soldier's right is +X
# Each clip is followed by one spare frame holding its loop-closing key, so the shader can interpolate
# from a clip's last frame into the next without bleeding into the following clip.
CLIPS = [('idle', 0, 60, True), ('walk', 61, 30, True), ('run', 92, 20, True),
         ('aim', 113, 40, True), ('fire', 154, 6, True), ('die', 161, 40, False),
         ('kneel', 203, 40, True), ('hop', 244, 16, False), ('deploy', 261, 48, True)]
BAKED = 310
FPS = 30.0

# Rest joints (game units: the soldier stands ~0.97 tall, as the procedural figure did).
SHOULDER = lambda s: (s * .158, -.005, .728)
ELBOW = lambda s: (s * .205, .02, .565)
WRIST = lambda s: (s * .215, .07, .455)
HIP = lambda s: (s * .075, 0, .465)
KNEE = lambda s: (s * .077, .022, .258)
ANKLE = lambda s: (s * .078, 0, .058)
TOE = lambda s: (s * .078, .115, .02)
WEAPON_AT = (.062, .145, .672)         # aim pose: stock in the right shoulder, muzzle forward

def grips(kind):
    """Right and left hand targets relative to the weapon bone head."""
    if kind == 'pistol': return (0, -.01, -.03), (-.012, .0, -.035)
    if kind == 'launcher': return (0, .02, -.07), (-.01, .17, -.055)
    return (0, -.045, -.048), (-.006, .105, -.016)

# ---------------------------------------------------------------- geometry
def weapon_parts(a, kind):
    o = Vector(WEAPON_AT)
    B = lambda c, s, k='polymer', bev=.003: a.box(tuple(o + Vector(c)), s, k, bevel=bev)
    C = lambda c, ax, r1, r2, L, k='dark', segs=8: a.cyl(tuple(o + Vector(c)), ax, r1, r2, L, k, segs=segs, bevel=0)
    if kind == 'pistol':
        B((0, .03, .0), (.022, .1, .028), 'dark'); B((0, -.005, -.035), (.02, .03, .06))
        return
    if kind == 'launcher':
        C((0, -.22, .03), 'y', .042, .042, .5, 'cloth2', 12); C((0, .26, .03), 'y', .05, .046, .06, 'dark', 12)
        C((0, -.24, .03), 'y', .05, .05, .04, 'dark', 12)
        B((0, .03, -.035), (.02, .03, .07), 'dark'); B((.03, .02, .07), (.025, .06, .04), 'dark', .004)
        B((0, .17, -.04), (.02, .025, .05), 'dark')
        return
    ak = kind == 'ak'; short = kind == 'carbine'
    B((0, -.005, .0), (.032, .13, .046))                       # receiver
    B((0, .09, .015), (.036, .11 if not short else .08, .034), 'wood' if ak else 'polymer', .004)   # handguard
    C((0, .14 if not short else .12, .022), 'y', .006, .006, .11 if not short else .07)               # barrel
    C((0, .245 if not short else .19, .022), 'y', .011, .011, .02)
    B((0, -.115, -.005), (.026, .09, .042), 'wood' if ak else 'polymer', .006)   # stock
    B((0, -.16, -.012), (.032, .012, .058), 'dark')
    for k in range(4):                                            # curved magazine
        B((0, .025 - k * .009 * (1.4 if ak else 1), -.03 - k * .012), (.02, .028, .016), 'dark' if ak else 'polymer', .002)
    B((0, -.05, -.035), (.02, .022, .05))                         # pistol grip
    if not ak:
        B((0, .03, .033), (.014, .17, .006), 'dark', 0)            # rail and optic
        B((0, -.005, .05), (.022, .045, .028), 'dark', .004)
        B((0, .018, .05), (.016, .002, .02), 'optic', 0)
    if kind == 'carbine':
        C((0, .19, .022), 'y', .014, .014, .09, 'dark', 10)        # suppressor

# ---------------------------------------------------------------- stylised, low-poly figure (2026-11-16)
# The game's art direction: slightly exaggerated proportions (a larger head and helmet, broad shoulders,
# chunky hands, boots and weapon), a low polygon count (~600 triangles) and a silhouette that reads at RTS
# distance. The helmet (or cap / hard hat) and the shoulder pads are a separate overlay mesh
# (SoldierTeam<r>.bytes, same bones) drawn in the owner's strong team colour; the body keeps the faction's
# field uniform, lighter than before so troops never read as dark blobs.
PAL['uniform'] = ((.93, .93, .88), FABRIC)    # takes the faction uniform tint (instance colour)
PAL['uniform2'] = ((.80, .81, .74), FABRIC)
PAL['kit'] = ((.58, .58, .51), FABRIC)        # webbing, pouches, pack
PAL['gun'] = ((.30, .30, .29), PLAIN)
PAL['team'] = ((.97, .97, .97), PLAIN)        # overlay: multiplied by the team colour only
PAL['teamdark'] = ((.62, .62, .62), PLAIN)    # overlay trim (helmet rim, pad edge)
HEAD = 1.22                                   # head and helmet exaggeration

def low_limb(a, p0, p1, r0, r1, key, segs=6):
    d = Vector(p1) - Vector(p0)
    a.cyl(p0, d, r0, r1, d.length, key, segs=segs, bevel=0)
    a.ellipsoid(p0, (r0, r0, r0), key, segs, 3)

def low_weapon(a, kind):
    o = Vector(WEAPON_AT)
    B = lambda c, s, k='gun': a.box(tuple(o + Vector(c)), s, k, bevel=0)
    C = lambda c, ax, r1, r2, L, k='gun', segs=6: a.cyl(tuple(o + Vector(c)), ax, r1, r2, L, k, segs=segs, bevel=0)
    if kind == 'pistol':
        B((0, .03, 0), (.028, .11, .034)); B((0, -.005, -.04), (.026, .034, .068))
        return
    if kind == 'launcher':
        C((0, -.24, .03), 'y', .05, .05, .54, 'uniform2', 8); C((0, .28, .03), 'y', .058, .052, .07, 'gun', 8)
        B((0, .03, -.04), (.026, .036, .08)); B((.035, .02, .075), (.03, .07, .045))
        return
    short = kind == 'carbine'
    L = .8 if short else 1.0
    B((0, -.005, 0), (.042, .15, .056))                                   # receiver
    B((0, .1 * L, .014), (.044, .12 * L, .044), 'wood' if kind == 'ak' else 'gun')
    C((0, .15 * L, .02), 'y', .009, .009, .13 * L, 'gun', 5)              # barrel
    B((0, -.125, -.006), (.036, .1, .054), 'wood' if kind == 'ak' else 'gun')   # stock
    B((0, .02, -.045), (.026, .036, .07))                                 # magazine
    B((0, -.05, -.04), (.024, .026, .056))                                # grip
    if kind != 'ak': B((0, -.005, .048), (.026, .06, .03))                # optic

def soldier_parts(role, team):
    """The body (team=False) or its team-coloured overlay (team=True: helmet / cap / hard hat, shoulder pads)."""
    a = Asset(('SoldierTeam%d' if team else 'Soldier%d') % role)
    exo, militia, special, engineer = role == 4, role == 2, role == 3, role == 1
    bulk = 1.2 if exo else 1.06
    bi = {n: i for i, n in enumerate(DEFORM)}
    if team:
        # --- head gear in the team colour, oversized for the stylised read from above
        a.bone = bi['head']
        h = HEAD
        z0 = .852
        if engineer:
            a.lathe([(0, z0 + .115 * h), (.075 * h, z0 + .108 * h), (.1 * h, z0 + .072 * h), (.106 * h, z0 + .03 * h),
                     (.135 * h, z0 + .02 * h), (.135 * h, z0 + .012 * h), (0, z0 + .012 * h)], 'z', 'team', segs=10)
        elif militia:
            a.lathe([(0, z0 + .09 * h), (.078 * h, z0 + .085 * h), (.09 * h, z0 + .05 * h), (.092 * h, z0 + .022 * h), (0, z0 + .022 * h)], 'z', 'team', segs=10)
            a.box((0, .088 * h, z0 + .028 * h), (.11 * h, .065 * h, .012), 'teamdark', bevel=0)     # peak
        else:
            a.lathe([(0, z0 + .118 * h), (.064 * h, z0 + .112 * h), (.097 * h, z0 + .084 * h), (.112 * h, z0 + .04 * h),
                     (.118 * h, z0 + .004 * h), (.11 * h, z0 - .002 * h), (0, z0 - .002 * h)], 'z', 'team', segs=10)
            a.lathe([(.119 * h, z0 + .002 * h), (.122 * h, z0 + .016 * h), (.12 * h, z0 + .02 * h), (.116 * h, z0 + .006 * h)], 'z', 'teamdark', segs=10)
        # --- shoulder pads (both sides), the second team-colour read
        a.bone = bi['chest']
        for s in (-1, 1):
            a.ellipsoid((s * .162 * bulk, -.004, .73), ((.078 if exo else .066) * bulk, .078 if exo else .068, .05), 'team', 7, 4)
        return a
    # --- hips: pelvis and belt
    a.bone = bi['hips']
    a.ellipsoid((0, 0, .475), (.13 * bulk, .09, .09), 'uniform', 8, 5)
    a.box((0, 0, .51), (.28 * bulk, .19, .04), 'kit', bevel=0)
    for s in (-1, 1): a.box((s * .14 * bulk, .025, .485), (.035, .075, .085), 'kit', bevel=0)
    if engineer: a.box((.16, .03, .46), (.035, .065, .1), 'gun', bevel=0)
    # --- chest: a broad, slightly heroic torso with a carrier and pack
    a.bone = bi['chest']
    a.ellipsoid((0, 0, .59), (.13 * bulk, .09, .1), 'uniform', 8, 5)
    a.ellipsoid((0, -.004, .668), (.165 * bulk, .108, .108), 'uniform', 8, 5)
    a.cyl((0, 0, .74), 'z', .046, .044, .05, 'skin' if not special else 'kit', segs=6, bevel=0)
    if militia:
        a.box((0, .072, .615), (.23, .055, .12), 'kit', bevel=0)
        a.ellipsoid((0, .012, .755), (.08, .074, .036), 'uniform2', 7, 3)
    else:
        a.box((0, .045, .65), (.27 * bulk, .115, .215), 'uniform2', bevel=.012)
        a.box((0, -.052, .65), (.265 * bulk, .055, .205), 'uniform2', bevel=0)
        a.box((0, .112, .6), (.18, .036, .072), 'kit', bevel=0)              # pouch row
    pack = (.23, .11, .27) if engineer else (.2, .09, .22)
    a.box((0, -.13, .64), pack, 'kit', bevel=.02)
    if engineer: a.beam((-.07, -.17, .52), (-.06, -.16, .88), .011, 'wood', segs=4)
    if role == 5:
        for x in (-.05, .05): a.cyl((x, -.2, .5), 'z', .04, .04, .36, 'uniform2', segs=6, bevel=0)
    if role == 6: a.cyl((.05, -.2, .5), (0, -.2, 1), .034, .034, .42, 'gun', segs=6, bevel=0)
    if exo:
        a.box((0, -.18, .66), (.17, .075, .21), 'steel', bevel=.015)
        a.box((0, -.218, .66), (.022, .004, .15), 'optic', bevel=0)
    # --- head (larger than life; the team overlay carries the helmet)
    a.bone = bi['head']
    face = 'kit' if special else 'skin'
    h = HEAD
    a.ellipsoid((0, .006, .852 + .01 * (h - 1)), (.068 * h, .078 * h, .084 * h), face, 8, 6)
    if special: a.box((0, .09 * h, .9), (.06 * h, .035, .035), 'gun', bevel=0)               # night-vision
    elif exo: a.box((0, .085 * h, .862), (.11 * h, .022, .05), 'optic', bevel=0)
    elif not militia and not engineer: a.box((0, .086 * h, .905), (.1 * h, .024, .026), 'glass', bevel=0)   # goggles on the brow
    # --- arms: chunky, with big gloved hands
    for name, s in SIDES:
        a.bone = bi['upperarm.' + name]
        low_limb(a, SHOULDER(s), ELBOW(s), .048 * bulk, .041 * bulk, 'uniform')
        a.bone = bi['forearm.' + name]
        low_limb(a, ELBOW(s), WRIST(s), .04 * bulk, .034 * bulk, 'uniform')
        d = (Vector(WRIST(s)) - Vector(ELBOW(s))).normalized()
        a.ellipsoid(tuple(Vector(WRIST(s)) + d * .032), (.034, .036, .042), 'glove', 6, 4)
    # --- legs: sturdy, with oversized boots for a firm stance
    for name, s in SIDES:
        a.bone = bi['thigh.' + name]
        low_limb(a, HIP(s), KNEE(s), .072 * bulk, .056 * bulk, 'uniform')
        a.bone = bi['shin.' + name]
        low_limb(a, KNEE(s), ANKLE(s), .054 * bulk, .044 * bulk, 'uniform')
        a.bone = bi['foot.' + name]
        a.box((ANKLE(s)[0], .045, .04), (.092, .2, .082), 'boot', bevel=.012)
    # --- weapon, a size up so it reads
    a.bone = bi['weapon']
    low_weapon(a, WEAPON[role])
    return a

def soldier_mesh_detailed(role):
    """The previous high-detail figure (kept for reference; no longer exported)."""
    a = Asset('Soldier%d' % role)
    exo, militia, special, engineer = role == 4, role == 2, role == 3, role == 1
    bulk = 1.18 if exo else 1.0
    bi = {n: i for i, n in enumerate(DEFORM)}
    # --- hips: pelvis, belt kit
    a.bone = bi['hips']
    a.ellipsoid((0, 0, .475), (.128 * bulk, .088, .088), 'cloth', 14, 8)
    a.box((0, 0, .51), (.27 * bulk, .185, .036), 'webbing', bevel=.008)
    a.box((0, -.1, .485), (.12, .05, .07), 'webbing', bevel=.012)
    for s in (-1, 1): a.box((s * .135 * bulk, .02, .49), (.03, .07, .08), 'webbing', bevel=.008)
    if engineer: a.box((.15, .03, .46), (.03, .06, .09), 'dark', bevel=.006)
    # --- chest: torso, armour carrier, pouches, pack
    a.bone = bi['chest']
    a.ellipsoid((0, 0, .585), (.124 * bulk, .086, .1), 'cloth', 14, 8)
    a.ellipsoid((0, -.004, .665), (.152 * bulk, .102, .105), 'cloth', 14, 8)
    for s in (-1, 1): a.ellipsoid((s * .138 * bulk, -.005, .712), (.058, .058, .052), 'cloth', 10, 6)
    a.cyl((0, 0, .74), 'z', .04, .038, .055, 'skin' if not special else 'webbing', segs=10, bevel=0)
    if militia:
        # chest rig over a jacket, and a scarf at the throat
        a.box((0, .07, .615), (.22, .05, .11), 'webbing', bevel=.012)
        for x in (-.07, 0, .07): a.box((x, .1, .6), (.05, .03, .07), 'cloth2', bevel=.008)
        a.ellipsoid((0, .01, .755), (.075, .07, .035), 'cloth2', 12, 6)
    else:
        a.box((0, .045, .65), (.255 * bulk, .11, .205), 'paint' if exo else 'cloth2', bevel=.014)
        a.box((0, -.05, .65), (.25 * bulk, .05, .2), 'paint' if exo else 'cloth2', bevel=.012)
        for x in (-.075, 0, .075): a.box((x, .108, .6), (.056, .034, .07), 'webbing', bevel=.008)
        a.box((-.13 * bulk, .03, .63), (.035, .05, .09), 'webbing', bevel=.008)     # radio pouch
        for s in (-1, 1): a.box((s * .085, .01, .735), (.05, .12, .02), 'webbing', bevel=.005)   # shoulder straps
    pack = (.22, .1, .26) if engineer else (.19, .085, .21)
    a.box((0, -.125, .64), pack, 'cloth2', bevel=.025)
    a.box((0, -.17, .64), (pack[0] * .7, .02, pack[2] * .55), 'webbing', bevel=.008)
    if engineer:
        a.beam((-.07, -.17, .52), (-.06, -.16, .86), .009, 'wood'); a.box((-.06, -.16, .88), (.05, .006, .07), 'steel', bevel=0)
    if role == 5:
        for x in (-.05, .05): a.cyl((x, -.19, .5), 'z', .036, .036, .36, 'cloth2', segs=10, bevel=0)
    if role == 6: a.cyl((.05, -.19, .5), (0, -.2, 1), .03, .03, .42, 'dark', segs=10, bevel=0)
    if exo:
        a.box((0, -.17, .66), (.16, .07, .2), 'steel', bevel=.02)
        a.box((0, -.207, .66), (.02, .003, .14), 'optic', bevel=0)
        for s in (-1, 1): a.ellipsoid((s * .17, -.005, .728), (.075, .085, .06), 'paint', 12, 6)
    if not special and not exo: a.beam((-.09, -.16, .78), (-.1, -.17, 1.02), .003, 'dark')    # radio whip (on some)
    # --- head
    a.bone = bi['head']
    face = 'webbing' if special else 'skin'
    a.ellipsoid((0, .006, .852), (.066, .077, .086), face, 14, 10)
    a.ellipsoid((0, .074, .848), (.012, .016, .018), face, 6, 4)                     # nose
    for s in (-1, 1): a.ellipsoid((s * .066, 0, .852), (.011, .018, .022), face, 6, 4)
    if engineer:
        a.lathe([(0, .962), (.07, .955), (.098, .925), (.105, .885), (.135, .875), (.135, .868), (.0, .868)], 'z', 'hardhat', segs=18)
    elif militia:
        a.lathe([(0, .935), (.075, .93), (.088, .9), (.09, .875), (.0, .875)], 'z', 'cloth2', segs=16)
        a.box((0, .085, .88), (.1, .06, .008), 'cloth2', bevel=0)
    else:
        a.lathe([(0, .965), (.06, .96), (.093, .935), (.108, .895), (.112, .862), (.105, .856), (0, .856)], 'z', 'cloth', segs=18)
        a.lathe([(.108, .885), (.111, .898), (.11, .9), (.107, .887)], 'z', 'webbing', segs=18)     # goggle band
        if special:
            a.box((0, .085, .925), (.05, .03, .03), 'dark', bevel=.005)
            for s in (-1, 1): a.cyl((s * .018, .1, .925), 'y', .011, .011, .04, 'dark', segs=8, bevel=0)
        else:
            a.box((0, .08, .9), (.09, .022, .025), 'glass', bevel=.004)               # goggles on the brow
        if exo: a.box((0, .072, .858), (.1, .02, .045), 'optic', bevel=.004)
    # --- arms
    for name, s in SIDES:
        a.bone = bi['upperarm.' + name]
        a.limb(SHOULDER(s), ELBOW(s), .043 * bulk, .037 * bulk, 'cloth')
        a.bone = bi['forearm.' + name]
        a.limb(ELBOW(s), WRIST(s), .036 * bulk, .03 * bulk, 'cloth')
        d = (Vector(WRIST(s)) - Vector(ELBOW(s))).normalized()
        a.ellipsoid(tuple(Vector(WRIST(s)) + d * .03), (.027, .03, .036), 'glove', 8, 6)
    # --- legs
    for name, s in SIDES:
        a.bone = bi['thigh.' + name]
        a.limb(HIP(s), KNEE(s), .068 * bulk, .052 * bulk, 'cloth')
        mid = Vector(HIP(s)) * .5 + Vector(KNEE(s)) * .5
        a.box((mid.x + s * .062, mid.y + .01, mid.z), (.024, .07, .08), 'cloth2', bevel=.008)  # cargo pocket
        a.bone = bi['shin.' + name]
        a.limb(KNEE(s), ANKLE(s), .05 * bulk, .04 * bulk, 'cloth')
        a.ellipsoid((KNEE(s)[0], KNEE(s)[1] + .045, KNEE(s)[2] - .01), (.045, .03, .05), 'webbing', 8, 6)   # knee pad
        a.bone = bi['foot.' + name]
        a.box((ANKLE(s)[0], .04, .042), (.078, .175, .075), 'boot', bevel=.016)
        a.box((ANKLE(s)[0], .04, .008), (.082, .18, .016), 'boot', bevel=.004)
    # --- weapon
    a.bone = bi['weapon']
    weapon_parts(a, WEAPON[role])
    return a

# ---------------------------------------------------------------- rig
def make_rig(collection, name, kind, offset):
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    collection.objects.link(arm)
    arm.location = offset
    bpy.context.view_layer.objects.active = arm
    for ob in bpy.context.selected_objects: ob.select_set(False)
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    def bone(n, head, tail, parent=None, deform=True):
        b = eb.new(n); b.head = head; b.tail = tail; b.roll = 0
        if parent: b.parent = eb[parent]
        b.use_deform = deform
        return b
    bone('root', (0, 0, 0), (0, .12, 0), deform=False)
    bone('hips', (0, 0, .465), (0, 0, .58), 'root')
    bone('chest', (0, 0, .58), (0, 0, .765), 'hips')
    bone('head', (0, 0, .765), (0, 0, .95), 'chest')
    w = Vector(WEAPON_AT)
    bone('weapon', tuple(w), tuple(w + Vector((0, .2, 0))), 'chest')
    gr, gl = grips(kind)
    bone('grip.R', tuple(w + Vector(gr)), tuple(w + Vector(gr) + Vector((0, .03, 0))), 'weapon', False)
    bone('grip.L', tuple(w + Vector(gl)), tuple(w + Vector(gl) + Vector((0, .03, 0))), 'weapon', False)
    for n, s in SIDES:
        bone('upperarm.' + n, SHOULDER(s), ELBOW(s), 'chest')
        bone('forearm.' + n, ELBOW(s), WRIST(s), 'upperarm.' + n).use_connect = True
        bone('elbow_pole.' + n, (s * .5, -.3, .48), (s * .5, -.18, .48), 'chest', False)
        bone('thigh.' + n, HIP(s), KNEE(s), 'hips')
        bone('shin.' + n, KNEE(s), ANKLE(s), 'thigh.' + n).use_connect = True
        bone('foot.' + n, ANKLE(s), TOE(s), 'shin.' + n).use_connect = True
        bone('foot_ik.' + n, ANKLE(s), (ANKLE(s)[0], ANKLE(s)[1] + .115, ANKLE(s)[2]), 'root', False)
        bone('knee_pole.' + n, (s * .08, .7, .27), (s * .08, .82, .27), 'root', False)
    bpy.ops.object.mode_set(mode='POSE')
    pb = arm.pose.bones
    for p in pb: p.rotation_mode = 'XYZ'
    for n, s in SIDES:
        ik = pb['forearm.' + n].constraints.new('IK')
        ik.target = arm; ik.subtarget = ('grip.R' if s > 0 else 'grip.L'); ik.chain_count = 2
        ik.pole_target = arm; ik.pole_subtarget = 'elbow_pole.' + n; ik.pole_angle = math.radians(-90)
        ik = pb['shin.' + n].constraints.new('IK')
        ik.target = arm; ik.subtarget = 'foot_ik.' + n; ik.chain_count = 2
        # +90 bends the knee toward the pole in front (-90 bent knees slightly backward in the gaits and
        # fully backward when kneeling; verified by solving the rig headless)
        ik.pole_target = arm; ik.pole_subtarget = 'knee_pole.' + n; ik.pole_angle = math.radians(90)
        cr = pb['foot.' + n].constraints.new('COPY_ROTATION')
        cr.target = arm; cr.subtarget = 'foot_ik.' + n
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm

# ---------------------------------------------------------------- animation
def animate(arm):
    pb = arm.pose.bones
    def key(n, f, loc=None, rot=None):
        b = pb[n]
        if loc is not None: b.location = loc; b.keyframe_insert('location', frame=f)
        if rot is not None: b.rotation_euler = rot; b.keyframe_insert('rotation_euler', frame=f)
    # Weapon carries (pose relative to the aim rest, armature axes: weapon/feet bones have identity rest).
    LOW = ((-.055, -.03, -.13), (-.62, 0, .42))        # low ready across the body
    PORT = ((-.06, -.02, -.07), (-.25, .2, .62))       # running: muzzle up, across the chest
    AIM = ((0, 0, 0), (0, 0, 0))
    def feet(f, l, r, rl=(0, 0, 0), rr=(0, 0, 0)):
        # rotation is keyed everywhere (rest = 0) so the kneeling clips' toe-down feet never leak into others
        key('foot_ik.L', f, loc=l, rot=rl); key('foot_ik.R', f, loc=r, rot=rr)
    def neutral(f, weapon=LOW, chest=0., hips=0., head=(0, 0, 0), stance=((0, 0, 0), (0, 0, 0))):
        key('root', f, loc=(0, 0, 0), rot=(0, 0, 0))
        key('hips', f, loc=(0, hips, 0), rot=(0, 0, 0))
        key('chest', f, rot=(chest, 0, 0)); key('head', f, rot=head)
        key('weapon', f, loc=weapon[0], rot=weapon[1])
        feet(f, stance[0], stance[1])
    # idle: calm, weight on the feet, breathing; the head only drifts a little (no sentry-style scanning)
    for k in range(0, 61, 6):
        t = k / 60
        neutral(k, weapon=((LOW[0][0], LOW[0][1], LOW[0][2] + math.sin(t * 2 * math.pi) * .004), LOW[1]),
                chest=-.03 + math.sin(t * 2 * math.pi) * .014, head=(.02 + math.sin(t * 2 * math.pi) * .012, math.sin(t * 2 * math.pi) * .07, 0),
                stance=((-.012, .015, 0), (.012, -.02, 0)))
    # walk and run: feet travel back while planted and swing forward with lift; hips bob, chest counter-rotates
    def gait(start, frames, stride, lift, planted, lean, bob, weapon, twist):
        for k in range(0, frames + 1, 2 if frames <= 20 else 3):
            t = k / frames
            pos = []
            for side_phase in (0, .5):
                u = (t + side_phase) % 1
                if u < planted: y = stride * (1 - 2 * u / planted); z = 0
                else:
                    w = (u - planted) / (1 - planted); sm = w * w * (3 - 2 * w)
                    y = stride * (-1 + 2 * sm); z = math.sin(w * math.pi) * lift
                pos.append((0, y, z))
            f = start + k
            key('root', f, loc=(0, 0, 0), rot=(0, 0, 0))
            key('hips', f, loc=(0, -bob * abs(math.sin(t * 2 * math.pi)) - (.03 if lean < -.15 else 0), 0), rot=(0, math.sin(t * 2 * math.pi) * twist, 0))
            key('chest', f, rot=(lean, -math.sin(t * 2 * math.pi) * twist * 1.3, 0))
            key('head', f, rot=(-lean * .6, math.sin(t * 2 * math.pi) * twist * .6, 0))
            key('weapon', f, loc=weapon[0], rot=weapon[1])
            feet(f, pos[0], pos[1])
    gait(61, 30, .17, .065, .56, -.06, .016, LOW, .07)
    gait(92, 20, .29, .12, .42, -.27, .03, PORT, .12)
    # aim: shouldered, staggered stance, slight crouch and sway
    for k in range(0, 41, 5):
        t = k / 40
        sway = (math.sin(t * 2 * math.pi) * .006, 0, math.sin(t * 4 * math.pi) * .004)
        neutral(113 + k, weapon=(sway, (math.sin(t * 2 * math.pi) * .01, 0, math.cos(t * 2 * math.pi) * .012)), chest=-.09, hips=-.025,
                head=(.12, -.05, 0), stance=((-.03, .1, 0), (.02, -.09, 0)))
    # fire: recoil kick into the shoulder, muzzle climb, recovery
    for k, (kick, climb) in enumerate([(0, 0), (-.03, .07), (-.02, .05), (-.01, .025), (-.004, .01), (0, 0), (0, 0)]):
        neutral(154 + k, weapon=((0, kick, kick * -.2), (climb, 0, 0)), chest=-.09 + climb * .5, hips=-.025, head=(.12, -.05, 0),
                stance=((-.03, .1, 0), (.02, -.09, 0)))
    # die: hit, knees buckle, falls backward and settles
    for f, (fall, sag, lean, wpn) in [(161, (0, 0, 0, 0)), (165, (.08, -.03, .18, .3)), (171, (.25, -.11, .1, .9)),
                                      (181, (1.0, -.16, -.2, 1.4)), (189, (1.5, -.12, -.25, 1.6)), (195, (1.45, -.12, -.22, 1.6)), (201, (1.48, -.12, -.24, 1.6))]:
        key('root', f, loc=(0, -.04 * min(1, fall), 0), rot=(fall, 0, fall * .12))
        key('hips', f, loc=(0, sag, 0), rot=(0, 0, 0))
        key('chest', f, rot=(lean, 0, 0)); key('head', f, rot=(lean * 1.4, .3 * min(1, fall), 0))
        key('weapon', f, loc=(-.05 * wpn, -.05 * wpn, -.12 * wpn), rot=(-.7 * wpn, 0, .5 * wpn))
        feet(f, (0, .04 * min(1, fall), 0), (0, -.05 * min(1, fall), 0))
    # kneel: down on the right knee, left foot planted forward, rifle shouldered, a slow settle and sway
    KNEEL_L, KNEEL_R, TOE_DOWN = (0, .14, 0), (0, -.22, .05), (-1.15, 0, 0)
    for k in range(0, 41, 5):
        t = k / 40
        sway = (math.sin(t * 2 * math.pi) * .005, 0, math.sin(t * 4 * math.pi) * .003)
        neutral(203 + k, weapon=(sway, (math.sin(t * 2 * math.pi) * .008, 0, math.cos(t * 2 * math.pi) * .01)),
                chest=-.11 + math.sin(t * 2 * math.pi) * .01, hips=-.19, head=(.10, -.04, 0))
        feet(203 + k, KNEEL_L, KNEEL_R, rr=TOE_DOWN)
    # hop: gather, spring, tuck, land deep and recover (a short drop into a trench; the game moves the body down)
    for k, (rise, sag, tuck, lean) in enumerate([(0, -.04, 0, -.08), (.012, -.07, 0, -.16), (.05, -.02, .03, -.12),
                                                  (.06, -.01, .05, -.1), (.02, -.05, .02, -.14), (0, -.11, 0, -.22),
                                                  (0, -.08, 0, -.16), (0, -.04, 0, -.1), (0, -.03, 0, -.08)]):
        f = 244 + k * 2
        key('root', f, loc=(0, 0, rise), rot=(0, 0, 0))
        key('hips', f, loc=(0, sag, 0), rot=(0, 0, 0))
        key('chest', f, rot=(lean, 0, 0)); key('head', f, rot=(-lean * .5, 0, 0))
        key('weapon', f, loc=PORT[0], rot=PORT[1])
        feet(f, (0, .05, tuck), (0, -.04, tuck * .8))
    # deploy: kneeling low over the weapon held upright in front, working it (as a crew handles a mortar tube)
    for k in range(0, 49, 6):
        t = k / 48
        work = math.sin(t * 2 * math.pi)
        neutral(261 + k, weapon=((-.03, -.04 + work * .01, -.12 + work * .025), (.9 + work * .12, 0, .22)),
                chest=-.5 + work * .05, hips=-.2, head=(.32 + work * .04, .05, 0))
        feet(261 + k, KNEEL_L, KNEEL_R, rr=TOE_DOWN)
    act = arm.animation_data.action if arm.animation_data else None
    if act:
        for fc in getattr(act, 'fcurves', []):
            for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'

# ---------------------------------------------------------------- bake
C = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))   # Blender (x,y,z) <-> Unity (x,z,y)

def bake(arm, path):
    scene = bpy.context.scene
    frames = BAKED
    rest_inv = {n: arm.data.bones[n].matrix_local.inverted() for n in DEFORM}
    with open(path, 'wb') as fh:
        fh.write(b'SEA1'); fh.write(struct.pack('<III', len(DEFORM), frames, len(CLIPS)))
        for name, start, count, loop in CLIPS:
            fh.write(name.encode('ascii').ljust(16, b'\0')); fh.write(struct.pack('<IIfI', start, count, FPS, 1 if loop else 0))
        for f in range(frames):
            scene.frame_set(f)
            for n in DEFORM:
                m = C @ (arm.pose.bones[n].matrix @ rest_inv[n]) @ C
                for r in range(3): fh.write(struct.pack('<4f', m[r][0], m[r][1], m[r][2], m[r][3]))
    return frames

# ---------------------------------------------------------------- main
scene = bpy.context.scene
scene.render.fps = int(FPS)
coll = bpy.data.collections.get('SE Soldiers') or bpy.data.collections.new('SE Soldiers')
if coll.name not in scene.collection.children: scene.collection.children.link(coll)
for ob in list(coll.objects): bpy.data.objects.remove(ob, do_unlink=True)
built = []
for role in range(len(ROLES)):
    arm = make_rig(coll, 'Rig_' + ROLES[role], WEAPON[role], (role * .55 - 1.65, 0, 0))
    animate(arm)
    mesh = soldier_parts(role, False)
    v, t = mesh.export(os.path.join(OUT, 'Soldier%d.bytes' % role), ao_radius=.05, ao_rays=12, ao_strength=.35)
    body = mesh.preview_object(coll, arm, DEFORM)
    body.data.shade_smooth()
    if hasattr(body.data, 'set_sharp_from_angle'): body.data.set_sharp_from_angle(angle=math.radians(38))
    body.name = 'Soldier_' + ROLES[role]
    gear = soldier_parts(role, True)
    tv, tt = gear.export(os.path.join(OUT, 'SoldierTeam%d.bytes' % role), ao_radius=.03, ao_rays=8, ao_strength=.25)
    gear.preview_object(coll, arm, DEFORM).name = 'SoldierTeam_' + ROLES[role]
    frames = bake(arm, os.path.join(OUT, 'SoldierAnim%d.bytes' % role))
    built.append((ROLES[role], v, t, frames))
    print('[se] %-14s %5d verts %5d tris (+ team %d tris) %d frames' % (ROLES[role], v, t, tt, frames))
scene.frame_start, scene.frame_end = 0, BAKED - 1
scene.frame_set(70)
print('[se] wrote %d soldiers to %s' % (len(built), OUT))
