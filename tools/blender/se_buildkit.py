# Shattered Empires — building kit: recorded parts, destruction stages and LODs on top of se_meshkit.
#
# A building is authored once as a list of recorded primitives (Rec: box / prism / cyl / beam / lathe / ring /
# ellipsoid, the se_meshkit vocabulary) plus its layout records (walls, team marks, flags, smoke, roof emblem
# spot, accent pieces, team bands, beacons, turret mounts). realize() replays the parts into a baked se_meshkit
# Asset for one destruction stage:
#
#   stage 0  intact
#   stage 1  damaged        blast holes through roofs and upper walls (dark interiors show through), blown-out
#                           windows, charred rims, missing details, small rubble spills, exposed frame members
#   stage 2  heavily damaged the stage 1 blasts grown, a collapsed section (roof gone, walls down to a jagged line,
#                           exposed columns and trusses, a fallen roof slab), toppled masts, truncated stacks
#   stage 3  destroyed      a ruin footprint: wall stubs cut to a jagged line, rubble mounds over every hall,
#                           chunks and fallen slabs, bent frame stubs, charred pads
#
# Damage is generated from the intact geometry, deterministic per building name: every primitive gets a role
# (shell / tall / detail / glass / ground) from its shape, blasts are placed on the largest shells' roof corners,
# and faces are refined, cut and charred per part. The same blasts drive the layout records' stage visibility
# ("@N" suffix: drawn while the stage is <= N), so team marks and emblems vanish with the roof they sat on.
# LOD (lod=True): small details dropped, segment counts halved, no bevels, coarser damage refinement.
import bmesh, math, random
from mathutils import Vector, Matrix, Euler
import se_meshkit
from se_meshkit import Asset, PAL, CONCRETE, BRICK, SHEET, ASPHALT, FABRIC, PLAIN, GLASS, SOIL, ROCK, ARMOR

GLASS_KEYS = {'window', 'glass', 'optic', 'lamp', 'tail', 'glassb'}


def finalize_palette():
    """Add the damage palette and charred variants (key~1 scorched, key~2 burnt) of every key. Call once after
    all PAL.update calls and before any Asset is created (an Asset snapshots the key list)."""
    PAL.update({
        'interior': ((.42, .39, .35), CONCRETE), 'rubble': ((.60, .57, .52), ROCK), 'rubble2': ((.52, .48, .42), ROCK),
        'frame': ((.50, .44, .37), ARMOR), 'scorch': ((.34, .32, .29), SOIL),
    })
    for k in [k for k in PAL.keys() if '~' not in k]:
        (r, g, b), s = PAL[k]
        # scorched and burnt stay readable greys/browns of the original colour (2026-11-20, user: "they get too dark")
        PAL[k + '~1'] = ((r * .82, g * .79, b * .75), s)
        PAL[k + '~2'] = ((r * .60 + .05, g * .57 + .05, b * .53 + .04), s)


class KAsset(Asset):
    """An Asset whose faces also carry the recorded part id (pid)."""

    def __init__(self, name):
        super().__init__(name)
        self.pidl = self.bm.faces.layers.int.new('pid')
        self.pid = -1

    def _tag(self, faces, key):
        super()._tag(faces, key)
        for f in faces: f[self.pidl] = self.pid

    def key_of(self, f):
        return self.keys[f[self.mat]]

    def set_key(self, f, key):
        if key not in PAL: key = key.split('~')[0]
        f[self.mat] = self.keys.index(key)


def ring_band(a, r0, r1, z0, z1, key, segs=24, taper=1.0, cx=0., cy=0.):
    """A closed annular solid between radii r0 < r1 and heights z0 < z1 (taper scales the top outer radius)."""
    bm = a.bm; before = set(bm.faces)
    rings = []
    for (r, z) in ((r0, z0), (r1, z0), (r1 * taper, z1), (r0, z1)):
        rings.append([bm.verts.new((cx + math.cos(k / segs * math.tau) * r, cy + math.sin(k / segs * math.tau) * r, z)) for k in range(segs)])
    for i in range(4):
        A, B = rings[i], rings[(i + 1) % 4]
        for k in range(segs):
            kk = (k + 1) % segs
            bm.faces.new((A[k], A[kk], B[kk], B[k]))
    faces = [f for f in bm.faces if f not in before]
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    return a._finish(faces, key, 0)


def rbox(a, c, s, euler=(0, 0, 0), key='rubble', order='XYZ'):
    """A rotated box (rubble chunks, fallen slabs, emblem pieces) via create_cube with a matrix (no face scan)."""
    m = Matrix.Translation(Vector(c)) @ Euler(euler, order).to_matrix().to_4x4() @ Matrix.Diagonal((s[0], s[1], s[2], 1))
    res = bmesh.ops.create_cube(a.bm, size=1, matrix=m)
    faces = {f for v in res['verts'] for f in v.link_faces}
    a._tag(list(faces), key)


# ------------------------------------------------------------------ noise and blasts
def _hash(ix, iy, iz, seed):
    n = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
    n &= 0xffffffff
    n = ((n ^ (n >> 13)) * 1274126177) & 0xffffffff
    return ((n ^ (n >> 16)) & 0xffffff) / 16777216.


def vnoise(p, scale, seed):
    x, y, z = p[0] * scale, p[1] * scale, p[2] * scale
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    fx, fy, fz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
    def L(a, b, t): return a + (b - a) * t
    c = [[[_hash(ix + i, iy + j, iz + k, seed) for k in (0, 1)] for j in (0, 1)] for i in (0, 1)]
    return L(L(L(c[0][0][0], c[0][0][1], fz), L(c[0][1][0], c[0][1][1], fz), fy),
             L(L(c[1][0][0], c[1][0][1], fz), L(c[1][1][0], c[1][1][1], fz), fy), fx)


class Blast:
    def __init__(self, c, r, rz=None, collapse=False):
        self.c = Vector(c); self.r = r; self.rz = rz if rz is not None else r * 1.4; self.collapse = collapse

    def nd(self, p):
        d = Vector(p) - self.c
        return math.sqrt((d.x / self.r) ** 2 + (d.y / self.r) ** 2 + (d.z / self.rz) ** 2)

    def grown(self, k):
        return Blast(self.c, self.r * k, self.rz * k, self.collapse)


class PartInfo:
    def __init__(self, idx, kind, key, lo, hi, role):
        self.idx, self.kind, self.key, self.lo, self.hi, self.role = idx, kind, key, lo, hi, role

    @property
    def size(self): return self.hi - self.lo

    @property
    def centre(self): return (self.lo + self.hi) * .5

    def volume(self):
        s = self.size
        return max(s.x, .001) * max(s.y, .001) * max(s.z, .001)


# ------------------------------------------------------------------ the recorder
class Rec:
    """A building as recorded primitives and layout records. `t` is the layout type key."""

    def __init__(self, name, t, seed=None):
        self.name, self.t = name, t
        self.parts = []
        self.records = []           # (text, anchors) ; anchors: list of points for stage visibility, None = always
        self.seed = seed if seed is not None else (sum(ord(ch) * (i + 1) for i, ch in enumerate(name)) & 0xffff)
        self.info = None            # PartInfo list from the intact realization
        self.blast_override = {}    # stage -> list of Blast (optional hand placement)
        self.protect = []           # roof emblem spots (x, y, top, half size): their roof survives stages 1 and 2

    def _add(self, kind, args, kw):
        role = kw.pop('role', None)
        self.parts.append((kind, args, kw, role))
        return self

    def box(self, *a, **k): return self._add('box', a, k)
    def prism(self, *a, **k): return self._add('prism', a, k)
    def cyl(self, *a, **k): return self._add('cyl', a, k)
    def beam(self, *a, **k): return self._add('beam', a, k)
    def lathe(self, *a, **k): return self._add('lathe', a, k)
    def ellipsoid(self, *a, **k): return self._add('ellipsoid', a, k)
    def ring(self, *a, **k): return self._add('ring', a, k)
    def rbox(self, *a, **k): return self._add('rbox', a, k)

    def obox(self, cx, cy, z0, z1, w, d, ang, key, bevel=.004, role=None):
        """A box w across and d along heading ang (0 = +Y), standing from z0 to z1."""
        s, c = math.sin(ang), math.cos(ang)
        pts = [(cx + u * c + v * s, cy - u * s + v * c) for (u, v) in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
        return self.prism(pts, 'z', z0, z1, key, bevel=bevel, role=role)

    # ---- layout records (Blender frame; the client mirrors x)
    def _rec(self, text, anchors):
        self.records.append((text, anchors))

    def wall(self, x, y, w, d, yaw=0.):
        self._rec('wall %s %.4f %.4f %.4f %.4f %.4f' % (self.t, x, y, w / 2, d / 2, yaw), None)

    def mark(self, x, y, z, w, h, d):
        self.protect.append((x, y, z, min(.08, max(w, d) * .5 + .02)))
        self._rec('mark %s %.4f %.4f %.4f %.4f %.4f %.4f' % (self.t, x, y, z, w, h, d), [(x, y, z)])

    def flag(self, x, y, h):
        self._rec('flag %s %.4f %.4f %.4f' % (self.t, x, y, h), [(x, y, .05)])

    def smoke(self, x, y, h, steam, size):
        self._rec('smoke %s %.4f %.4f %.4f %d %.3f' % (self.t, x, y, h, 1 if steam else 0, size), [(x, y, h - .03)])

    def mount(self, x, y, h):
        self._rec('mount %s %.4f %.4f %.4f' % (self.t, x, y, h), None)

    def plate(self, x, y, z):
        self._rec('plate %s %.4f %.4f %.4f' % (self.t, x, y, z), [(x, y, z)])

    def roof(self, x, y, z, size):
        """The roof emblem spot: centre, the top it lies on, plate size."""
        h = size * .45
        self.protect.append((x, y, z, size * .5 + .02))
        self._rec('roof %s %.4f %.4f %.4f %.4f' % (self.t, x, y, z, size),
                  [(x, y, z), (x - h, y - h, z), (x + h, y - h, z), (x - h, y + h, z), (x + h, y + h, z)])

    def accent(self, x, y, z, w, h, d, glow=.4):
        """A box in the facility's accent colour (bottom at z)."""
        self.protect.append((x, y, z, min(.08, max(w, d) * .5 + .02)))
        self._rec('accent %s %.4f %.4f %.4f %.4f %.4f %.4f %.3f' % (self.t, x, y, z, w, h, d, glow), [(x, y, z + h * .5)])

    def band(self, x, y, radius, z, h, segs, gap=0., glow=.3, accent=False):
        """A band of panels round a drum (team colour, or the accent colour): bottom at z."""
        anchors = [(x + math.cos(k * math.pi / 2) * radius, y + math.sin(k * math.pi / 2) * radius, z + h * .5) for k in range(4)]
        self._rec('band %s %.4f %.4f %.4f %.4f %.4f %d %.4f %.3f %d' % (self.t, x, y, radius, z, h, segs, gap, glow, 1 if accent else 0), anchors)

    def beacon(self, x, y, z, size, glow=1.2):
        self._rec('beacon %s %.4f %.4f %.4f %.4f %.3f' % (self.t, x, y, z, size, glow), [(x, y, z - .02)])

    def layout_lines(self, stages):
        """Records with their stage visibility suffix (@N: drawn while stage <= N)."""
        out = []
        for text, anchors in self.records:
            if anchors is None: out.append(text); continue
            last = 0
            if text.split(' ')[0] in ('roof', 'mark', 'accent', 'flag', 'plate'): out.append(text + ' @2'); continue
            for s in range(1, 4):
                if s == 3: break
                bl = stages.get(s, [])
                if any(b.nd(p) < 1.2 for b in bl for p in anchors): break
                last = s
            if text.startswith('beacon '): last = min(last, 1)
            out.append(text + ' @%d' % last)
        return out


# ------------------------------------------------------------------ realization
def _replay(a, kind, args, kw, lod, flat=False):
    kw = dict(kw)
    if flat and kind in ('box', 'prism', 'cyl'): kw['bevel'] = 0
    if lod:
        if 'segs' in kw: kw['segs'] = max(6, kw['segs'] // 2)
        if 'bevel' in kw: kw['bevel'] = 0
    if kind == 'box':
        if lod: kw['bevel'] = 0
        a.box(*args, **kw)
    elif kind == 'prism':
        if lod: kw['bevel'] = 0
        a.prism(*args, **kw)
    elif kind == 'cyl':
        if lod:
            kw['bevel'] = 0
            if 'segs' not in kw and len(args) < 7: kw['segs'] = 8
        a.cyl(*args, **kw)
    elif kind == 'beam':
        a.beam(*args, **kw)
    elif kind == 'lathe':
        if lod and 'segs' not in kw and len(args) < 4: kw['segs'] = 12
        a.lathe(*args, **kw)
    elif kind == 'ellipsoid':
        a.ellipsoid(*args, **kw)
    elif kind == 'ring':
        if lod and 'segs' in kw: kw['segs'] = max(8, kw['segs'] // 2)
        ring_band(a, *args, **kw)
    elif kind == 'rbox':
        rbox(a, *args, **kw)


def _key_arg(kind, args, kw):
    pos = {'box': 2, 'prism': 4, 'cyl': 5, 'beam': 3, 'lathe': 2, 'ellipsoid': 2, 'ring': 4, 'rbox': 3}[kind]
    if 'key' in kw: return kw['key']
    if len(args) > pos: return args[pos]
    return {'box': 'paint', 'prism': 'paint', 'cyl': 'steel', 'beam': 'steel', 'lathe': 'steel', 'ellipsoid': 'cloth', 'ring': 'concrete', 'rbox': 'rubble'}[kind]


def _infer_role(kind, key, lo, hi):
    s = hi - lo
    base = key.split('~')[0]
    if base in GLASS_KEYS: return 'glass'
    if hi.z <= .026: return 'ground'
    mx, mn = max(s.x, s.y, s.z), min(s.x, s.y, s.z)
    if mx < .05: return 'detail'
    if mn < .012 and mx < .14: return 'detail'
    if kind in ('cyl', 'beam', 'lathe') and s.z > 2.2 * max(s.x, s.y) and s.z > .14: return 'tall'
    if kind == 'beam' and max(s.x, s.y) < .03: return 'detail'
    return 'shell'


def _faces_by_pid(a):
    groups = {}
    for f in a.bm.faces:
        groups.setdefault(f[a.pidl], []).append(f)
    return groups


def _bounds(faces):
    lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
    for f in faces:
        for v in f.verts:
            for i in range(3):
                if v.co[i] < lo[i]: lo[i] = v.co[i]
                if v.co[i] > hi[i]: hi[i] = v.co[i]
    return lo, hi


def _refine(a, pid, L, near, iters=12):
    """Split the part's long edges (near the damage) until they are shorter than L; triangles throughout."""
    bm = a.bm
    for _ in range(iters):
        faces = [f for f in bm.faces if f[a.pidl] == pid]
        quads = [f for f in faces if len(f.verts) > 3]
        if quads: bmesh.ops.triangulate(bm, faces=quads)
        faces = [f for f in bm.faces if f[a.pidl] == pid]
        edges = set()
        for f in faces:   # longest-edge bisection keeps the triangles well shaped (no slivers)
            if not near(f): continue
            e = max(f.edges, key=lambda e: e.calc_length())
            if e.calc_length() > L: edges.add(e)
        if not edges: break
        bmesh.ops.subdivide_edges(bm, edges=list(edges), cuts=1, use_grid_fill=False)
    faces = [f for f in bm.faces if f[a.pidl] == pid]
    quads = [f for f in faces if len(f.verts) > 3]
    if quads: bmesh.ops.triangulate(bm, faces=quads)


def _interior(a, pid):
    """Give an opened part an inside: its remaining faces duplicated inward in the dark interior tone."""
    faces = [f for f in a.bm.faces if f[a.pidl] == pid]
    if not faces: return
    res = bmesh.ops.duplicate(a.bm, geom=faces)
    new = [g for g in res['geom'] if isinstance(g, bmesh.types.BMFace)]
    bmesh.ops.reverse_faces(a.bm, faces=new)
    k = a.keys.index('interior')
    for f in new: f[a.mat] = k


def _char(a, f, level):
    base = a.key_of(f).split('~')[0]
    cur = a.key_of(f)
    curlevel = int(cur.split('~')[1]) if '~' in cur else 0
    if level > curlevel: a.set_key(f, base + '~%d' % level)


class Builder:
    """Realizes a Rec for one stage."""

    def __init__(self, rec, stage, lod):
        self.rec, self.stage, self.lod = rec, stage, lod
        self.rnd = random.Random(rec.seed * 7 + stage * 1013)
        self.a = KAsset(rec.name + '_s%d' % stage + ('_lo' if lod else ''))

    def build(self):
        a, rec = self.a, self.rec
        for i, (kind, args, kw, role) in enumerate(rec.parts):
            a.pid = i
            _replay(a, kind, args, kw, self.lod, self.stage > 0)
        groups = _faces_by_pid(a)
        if rec.info is None:
            info = []
            for i, (kind, args, kw, role) in enumerate(rec.parts):
                faces = groups.get(i, [])
                if not faces: info.append(None); continue
                lo, hi = _bounds(faces)
                key = _key_arg(kind, args, kw)
                info.append(PartInfo(i, kind, key, lo, hi, role or _infer_role(kind, key, lo, hi)))
            rec.info = info
        if self.lod:   # drop the small details at distance
            dead = []
            for p in rec.info:
                if p is None: continue
                s = p.size
                if p.role == 'detail' and max(s.x, s.y, s.z) < .045: dead += groups.get(p.idx, [])
            if dead: bmesh.ops.delete(a.bm, geom=dead, context='FACES')
        if self.stage == 0: return a
        self.next_pid = len(rec.parts) + 10
        if self.stage == 3: self.ruin()
        else: self.damage(blasts_for(rec, self.stage))
        return a

    # ---- helpers that add new geometry after the recorded parts
    def new_pid(self):
        self.next_pid += 1
        self.a.pid = self.next_pid
        return self.next_pid

    def chunk(self, x, y, s, key):
        self.new_pid()
        r = self.rnd
        size = (s * (.7 + r.random() * .8), s * (.6 + r.random() * .7), s * (.35 + r.random() * .45))
        rbox(self.a, (x, y, size[2] * .3), size, ((r.random() - .5) * .9, (r.random() - .5) * .9, r.random() * 6.28), key)

    def heap(self, x, y, rx, ry, h, keys, n):
        """A rubble mound with chunks on it."""
        self.new_pid()
        segs = 7 if self.lod else 9
        self.a.ellipsoid((x, y, 0), (rx, ry, h), 'rubble' if self.rnd.random() < .6 else 'rubble2', segs=segs, rings=4)
        if self.lod: n = max(2, n // 2)
        for k in range(n):
            ang = self.rnd.random() * 6.283; d = math.sqrt(self.rnd.random())
            px, py = x + math.cos(ang) * rx * d, y + math.sin(ang) * ry * d
            top = h * max(0., 1 - d * d) ** .5
            key = keys[k % len(keys)]
            self.new_pid()
            s = .014 + self.rnd.random() * .028
            r = self.rnd
            size = (s * (.7 + r.random() * .8), s * (.6 + r.random() * .7), s * (.4 + r.random() * .4))
            rbox(self.a, (px, py, top * .8 + size[2] * .2), size, ((r.random() - .5) * 1.2, (r.random() - .5) * 1.2, r.random() * 6.28), key)

    def slab(self, x, y, z, w, d, t, tilt, yaw, key):
        self.new_pid()
        rbox(self.a, (x, y, z), (w, d, t), (tilt, 0, yaw), key)

    def column(self, x, y, z0, z1, bend=0., ang=0.):
        self.new_pid()
        if bend <= 0:
            self.a.beam((x, y, z0), (x, y, z1), .006, 'frame', segs=3)
            return
        zm = z0 + (z1 - z0) * .55
        self.a.beam((x, y, z0), (x, y, zm), .006, 'frame', segs=3)
        L = (z1 - zm)
        self.a.beam((x, y, zm), (x + math.cos(ang) * L * bend, y + math.sin(ang) * L * bend, zm + L * (1 - bend * .7)), .006, 'frame', segs=3)

    def frame_in(self, p, blast, density=.14):
        """Exposed columns and roof trusses of shell p where blast opened it."""
        lo, hi = p.lo, p.hi
        nx = max(2, int((hi.x - lo.x) / density) + 1); ny = max(2, int((hi.y - lo.y) / density) + 1)
        z0, z1 = max(lo.z, 0.), hi.z - .006
        if z1 - z0 < .08: return
        cols = []
        for i in range(nx):
            for j in range(ny):
                x = lo.x + .02 + (hi.x - lo.x - .04) * i / (nx - 1)
                y = lo.y + .02 + (hi.y - lo.y - .04) * j / (ny - 1)
                if math.hypot((x - blast.c.x) / blast.r, (y - blast.c.y) / blast.r) > 1.05: continue
                cols.append((x, y, i, j))
        for (x, y, i, j) in cols:
            top = z1 - (self.rnd.random() * .05 if self.stage == 2 else 0)
            bend = .5 if (self.stage == 2 and self.rnd.random() < .25) else 0
            self.column(x, y, z0, top, bend, self.rnd.random() * 6.28)
        # trusses across the short span at each column line inside the blast
        along_x = (hi.x - lo.x) < (hi.y - lo.y)
        lines = {}
        for (x, y, i, j) in cols: lines.setdefault(j if along_x else i, []).append((x, y))
        for pts in lines.values():
            if len(pts) < 2: continue
            pts.sort()
            p0, p1 = pts[0], pts[-1]
            drop = .06 if (self.stage == 2 and self.rnd.random() < .4) else 0.
            self.new_pid()
            self.a.beam((p0[0], p0[1], z1), (p1[0], p1[1], z1 - drop), .005, 'frame', segs=3)

    # ---- stage 1 / 2
    def damage(self, blasts):
        a, rec, st = self.a, self.rec, self.stage
        L = .1 * (1.6 if self.lod else 1.)
        seed = rec.seed + st
        groups = _faces_by_pid(a)

        def nd_min(p): return min((b.nd(p) for b in blasts), default=99.)

        def fnear(f):
            return _face_nd(f, blasts) < 1.45

        heaps = []; heaped = set()
        for p in rec.info:
            if p is None: continue
            faces = groups.get(p.idx, [])
            if not faces: continue
            c = p.centre
            if p.role == 'emblem':
                if st == 2:
                    for f in faces:
                        if _hash(f.index, 11, 3, seed) < .45: _char(a, f, 1)
                continue
            if p.role == 'ground':
                for f in faces:
                    q = f.calc_center_median()
                    m = min((math.hypot((q.x - b.c.x) / b.r, (q.y - b.c.y) / b.r) for b in blasts), default=99)
                    if m < .7: _char(a, f, 2)
                    elif m < 1.3: _char(a, f, 1)
                continue
            if p.role == 'glass':
                m = nd_min(c)
                blown = m < 1.7 or (st == 2 and _hash(p.idx, 3, 1, seed) < .35) or (st == 1 and _hash(p.idx, 4, 1, seed) < .12)
                if blown:
                    k = a.keys.index('interior')
                    for f in faces: f[a.mat] = k
                continue
            if p.role == 'detail':
                m = nd_min(c)
                if m < 1.25 or (st == 2 and _hash(p.idx, 5, 2, seed) < .22):
                    bmesh.ops.delete(a.bm, geom=faces, context='FACES')
                    if self.rnd.random() < .5 and not self.lod:
                        ang = self.rnd.random() * 6.28
                        self.chunk(c.x + math.cos(ang) * .04, c.y + math.sin(ang) * .04, max(.012, min(.03, max(p.size.x, p.size.y) * .5)), p.key.split('~')[0] + '~1')
                elif m < 1.8:
                    for f in faces: _char(a, f, 1)
                continue
            if p.role == 'tall':
                top = Vector((c.x, c.y, p.hi.z - p.size.z * .2))
                hit = nd_min(top) < 1.4 or (st == 2 and _hash(p.idx, 6, 3, seed) < .45)
                if not hit:
                    for f in faces:
                        if nd_min(f.calc_center_median()) < 1.8: _char(a, f, 1)
                    continue
                thin = max(p.size.x, p.size.y) < .06
                frac = (.4 + self.rnd.random() * .25) if st == 1 else (.25 + self.rnd.random() * .25)
                cut = p.lo.z + p.size.z * frac
                if thin:
                    bmesh.ops.delete(a.bm, geom=faces, context='FACES')
                    self.new_pid()
                    a.beam((c.x, c.y, max(p.lo.z, 0)), (c.x, c.y, cut), max(.004, min(.02, p.size.x * .4)), p.key, segs=6)
                    ang = self.rnd.random() * 6.28; Lf = p.size.z * (1 - frac)
                    self.new_pid()
                    a.beam((c.x + math.cos(ang) * .03, c.y + math.sin(ang) * .03, .01),
                           (c.x + math.cos(ang) * (Lf + .03), c.y + math.sin(ang) * (Lf + .03), .03), max(.004, min(.02, p.size.x * .4)), p.key.split('~')[0] + '~1', segs=6)
                    continue
                _refine(a, p.idx, L * 1.4, lambda f: abs(f.calc_center_median().z - cut) < .1)
                faces = [f for f in a.bm.faces if f[a.pidl] == p.idx]
                dead = [f for f in faces if f.calc_center_median().z > cut + (vnoise(f.calc_center_median(), 30, seed) - .5) * .06]
                if dead: bmesh.ops.delete(a.bm, geom=dead, context='FACES')
                _interior(a, p.idx)
                for f in [f for f in a.bm.faces if f[a.pidl] == p.idx]:
                    if f.calc_center_median().z > cut - .06: _char(a, f, 2 if st == 2 else 1)
                heaps.append((c.x + .05, c.y + .03, .05 + p.size.x * .3, p.key))
                continue
            # shell
            hits = [b for b in blasts if _box_hit(p, b)]
            if not hits:
                continue
            _refine(a, p.idx, L, fnear)
            faces = [f for f in a.bm.faces if f[a.pidl] == p.idx]
            dead = []
            for f in faces:
                q = f.calc_center_median()
                m = nd_min(q)
                thr = .82 + (vnoise(q, 22, seed) - .5) * .5 + (_hash(f.index, 7, 7, seed) - .5) * .15
                if m < thr and not _protected(rec, q): dead.append(f)
            if dead and len(dead) < len(faces):
                bmesh.ops.delete(a.bm, geom=dead, context='FACES')
                _interior(a, p.idx)
            elif dead:   # the blast swallowed the whole part
                bmesh.ops.delete(a.bm, geom=dead, context='FACES')
            for f in [f for f in a.bm.faces if f[a.pidl] == p.idx]:
                m = nd_min(f.calc_center_median())
                if m < .95: _char(a, f, 2)
                elif m < 1.35: _char(a, f, 1)
            if dead and p.size.z > .07 and min(p.size.x, p.size.y) > .08:
                for b in hits:
                    if b.c.z - b.rz < p.hi.z: self.frame_in(p, b)
                    # rubble spills where the wall opened: at the blast, clamped onto the part's edge
                    x = min(max(b.c.x, p.lo.x - .03), p.hi.x + .03); y = min(max(b.c.y, p.lo.y - .03), p.hi.y + .03)
                    if id(b) not in heaped:
                        heaped.add(id(b))
                        heaps.append((x, y, b.r * (.5 if st == 1 else .75), p.key))
                    if st == 2 and b.collapse and not self.lod:
                        # a fallen roof slab from the wall top into the hole
                        ang = math.atan2(b.c.y - p.centre.y, b.c.x - p.centre.x)
                        self.slab(b.c.x - math.cos(ang) * b.r * .3, b.c.y - math.sin(ang) * b.r * .3, p.hi.z * .45,
                                  b.r * 1.1, b.r * .8, .014, .55, ang + 1.57, 'roofm~1' if 'roofm' in PAL else 'concrete~1')
        for (x, y, r, key) in heaps:
            base = key.split('~')[0]
            n = int(3 + r * 32)
            self.heap(x, y, r * .9, r * .75, .025 + r * .22, [base + '~1', 'rubble', base], n)

    # ---- stage 3
    def ruin(self):
        a, rec = self.a, self.rec
        L = .08 * (1.6 if self.lod else 1.)
        seed = rec.seed + 3
        groups = _faces_by_pid(a)
        shells = [p for p in rec.info if p is not None and p.role == 'shell']
        for p in rec.info:
            if p is None: continue
            faces = groups.get(p.idx, [])
            if not faces: continue
            c = p.centre
            if p.role == 'ground':
                for f in faces:
                    q = f.calc_center_median()
                    v = vnoise(q, 9, seed)
                    if v < .45: _char(a, f, 2 if v < .25 else 1)
                continue
            if p.role in ('glass', 'detail', 'emblem'):
                bmesh.ops.delete(a.bm, geom=faces, context='FACES')
                if p.role == 'detail' and self.rnd.random() < .3 and not self.lod:
                    self.chunk(c.x, c.y, max(.012, min(.03, max(p.size.x, p.size.y) * .5)), p.key.split('~')[0] + '~2')
                continue
            if p.role == 'tall':
                thin = max(p.size.x, p.size.y) < .06
                if thin or p.lo.z > .08:
                    bmesh.ops.delete(a.bm, geom=faces, context='FACES')
                    if thin and p.lo.z < .05:
                        ang = self.rnd.random() * 6.28; Lf = p.size.z * .8
                        self.new_pid()
                        a.beam((c.x, c.y, .01), (c.x + math.cos(ang) * Lf, c.y + math.sin(ang) * Lf, .02), max(.004, min(.02, p.size.x * .4)), p.key.split('~')[0] + '~2', segs=6)
                    continue
                cut = p.lo.z + p.size.z * (.15 + self.rnd.random() * .2)
            else:
                if p.lo.z > .1 or (p.lo.z > .05 and p.size.z < .06):
                    # roofs and anything standing on the building: gone (they fall into the mound)
                    bmesh.ops.delete(a.bm, geom=faces, context='FACES')
                    continue
                h = p.size.z
                cut = max(p.lo.z, 0.) + min(.17, max(.03, h * (.16 + self.rnd.random() * .3)))
                if h < .07: cut = p.hi.z   # low walls and plinth-like solids keep their height
            if cut >= p.hi.z - .005:
                for f in faces: _char(a, f, 1)
                continue
            def straddle(f, cut=cut):
                zs = [v.co.z for v in f.verts]
                return min(zs) < cut + .05 and max(zs) > cut - .05
            above = [f for f in faces if min(v.co.z for v in f.verts) > cut + .05]
            if above: bmesh.ops.delete(a.bm, geom=above, context='FACES')
            _refine(a, p.idx, L, straddle)
            faces = [f for f in a.bm.faces if f[a.pidl] == p.idx]
            dead = []
            gap = Blast((c.x + (self.rnd.random() - .5) * p.size.x, c.y + (self.rnd.random() - .5) * p.size.y, 0), .06 + self.rnd.random() * .05, .12)
            for f in faces:
                q = f.calc_center_median()
                jag = (vnoise(q, 26, seed) - .5) * .07 + (_hash(f.index, 9, 9, seed) - .5) * .02
                if q.z > cut + jag or gap.nd(q) < .9: dead.append(f)
            if dead: bmesh.ops.delete(a.bm, geom=dead, context='FACES')
            _interior(a, p.idx)
            for f in [f for f in a.bm.faces if f[a.pidl] == p.idx]:
                _char(a, f, 2 if f.calc_center_median().z > cut - .04 else 1)
        # mounds over every hall, chunks, fallen slabs and bent frame stubs
        for p in shells:
            s = p.size
            if s.x * s.y < .006 or s.z < .06 or p.lo.z > .16: continue
            c = p.centre
            base = p.key.split('~')[0]
            h = min(.11, s.z * .38) * (.8 + self.rnd.random() * .3)
            n = int(min(18, max(4, s.x * s.y * 70)))
            self.heap(c.x, c.y, s.x * .46, s.y * .46, h, [base + '~1', base + '~2', 'rubble', base], n)
            if s.x * s.y > .03 and not self.lod:
                for k in range(1 + int(s.x * s.y * 8)):
                    self.slab(c.x + (self.rnd.random() - .5) * s.x * .6, c.y + (self.rnd.random() - .5) * s.y * .6, h * .7,
                              .06 + self.rnd.random() * .1, .05 + self.rnd.random() * .08, .012, (self.rnd.random() - .5) * .9, self.rnd.random() * 6.28,
                              (base if base in ('roofm', 'concrete', 'concrete2', 'roofl') else 'concrete') + '~1')
                for k in range(2 + int(s.x * s.y * 6)):
                    side = self.rnd.randrange(4)
                    t = self.rnd.random()
                    x = p.lo.x + .02 + (s.x - .04) * (t if side < 2 else (0 if side == 2 else 1))
                    y = p.lo.y + .02 + (s.y - .04) * (t if side >= 2 else (0 if side == 0 else 1))
                    self.column(x, y, 0, h + .04 + self.rnd.random() * .14, .6 if self.rnd.random() < .5 else 0, self.rnd.random() * 6.28)


def _protected(rec, q):
    """Whether a point lies on a roof emblem spot (the roof under the type's emblem stays up through stage 2)."""
    for (x, y, z, h) in rec.protect:
        if abs(q.x - x) < h and abs(q.y - y) < h and q.z > z - .09: return True
    return False


def _face_nd(f, blasts):
    """The normalized distance from the nearest blast to the face's bounding box."""
    lo = [min(v.co[i] for v in f.verts) for i in range(3)]; hi = [max(v.co[i] for v in f.verts) for i in range(3)]
    best = 99.
    for b in blasts:
        q = Vector((min(max(b.c.x, lo[0]), hi[0]), min(max(b.c.y, lo[1]), hi[1]), min(max(b.c.z, lo[2]), hi[2])))
        best = min(best, b.nd(q))
    return best


def _box_hit(p, b):
    """Whether blast b reaches part p's bounding box."""
    lo, hi = p.lo, p.hi
    q = Vector((min(max(b.c.x, lo.x), hi.x), min(max(b.c.y, lo.y), hi.y), min(max(b.c.z, lo.z), hi.z)))
    return b.nd(q) < 1.15


def blasts_for(rec, stage):
    """Deterministic blasts per stage from the intact parts: roof corners of the largest shells first."""
    if stage in rec.blast_override: return rec.blast_override[stage]
    rnd = random.Random(rec.seed * 31 + 5)
    shells = sorted([p for p in rec.info if p is not None and p.role == 'shell' and p.size.z > .06],
                    key=lambda p: -(p.size.x * p.size.y * (.3 + p.size.z)))
    talls = sorted([p for p in rec.info if p is not None and p.role == 'tall'], key=lambda p: -p.size.z)
    if not shells: return []
    main = shells[0]; sec = shells[1] if len(shells) > 1 else main
    def corner(p, sx, sy, r):
        k = .33 if p.kind in ('lathe', 'cyl', 'ring', 'ellipsoid') else .5   # round parts: on the rim, not the bbox corner
        return Blast((p.centre.x + sx * (p.size.x * k - .02), p.centre.y + sy * (p.size.y * k - .02), p.hi.z - .01), r)
    sx, sy = rnd.choice((-1, 1)), rnd.choice((-1, 1))
    rA = min(.15, max(.075, .42 * min(main.size.x, main.size.y)))
    A = corner(main, sx, sy, rA)
    B = Blast((sec.centre.x + (rnd.random() - .5) * sec.size.x * .5, sec.centre.y + (rnd.random() - .5) * sec.size.y * .5, sec.hi.z - .01),
              min(.11, max(.06, .4 * min(sec.size.x, sec.size.y))))
    C = Blast((main.centre.x + (rnd.random() - .5) * main.size.x * .4, main.centre.y + (rnd.random() - .5) * main.size.y * .4, main.hi.z), .065)
    one = [A, B, C]
    if stage == 1: return one
    two = [A.grown(1.3), B.grown(1.3), C.grown(1.25)]
    # the collapse: the far end of the main shell along its long axis
    if main.size.x >= main.size.y:
        cx = main.centre.x - sx * main.size.x * .3; cy = main.centre.y
    else:
        cx = main.centre.x; cy = main.centre.y - sy * main.size.y * .3
    rD = min(.24, max(.1, .55 * min(main.size.x, main.size.y)))
    two.append(Blast((cx, cy, main.hi.z), rD, rD * 1.7, collapse=True))
    if len(shells) > 2:
        p = shells[2]
        two.append(corner(p, rnd.choice((-1, 1)), rnd.choice((-1, 1)), min(.12, max(.06, .45 * min(p.size.x, p.size.y)))))
    if talls:
        t = talls[0]
        two.append(Blast((t.centre.x, t.centre.y, t.lo.z + t.size.z * .7), .07))
    return two


def realize(rec, stage, lod=False):
    return Builder(rec, stage, lod).build()
