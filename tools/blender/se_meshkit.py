# Shattered Empires — Blender mesh kit and exporter.
#
# Assets are modelled as real hard-surface parts in Blender (profiles extruded into solids,
# chamfered edges, lathed wheels and barrels), then baked for the game's instanced renderer:
#   * vertex colour  = palette colour x ray-traced ambient occlusion (contact shadows between parts)
#   * uv1.x          = SurfaceKind (selects the material layer in SE/InstancedLit)
#   * normals        = area-weighted, split at 38 degrees (hard edges stay crisp, curved parts smooth)
# Blender is right-handed Z-up; Unity is left-handed Y-up. (x, y, z) -> (x, z, y) is a reflection, so
# Blender's counter-clockwise front faces become Unity's clockwise front faces without re-winding.
# Blender +Y (forward) therefore becomes Unity +Z, the convention of the game's meshes.
#
# Output (.bytes, little endian):  'SEM1' u32 vertexCount u32 indexCount
#   float3 position[v]  float3 normal[v]  u8x4 color[v]  float surface[v]  float2 uv[v]  u32 index[i]
import bmesh, math, struct, random
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

# SurfaceKind (Runtime/Rendering/SurfaceTextures.cs)
PLAIN, CONCRETE, BRICK, SHEET, ROOFTILE, ASPHALT, ARMOR, RUBBER, FABRIC, GLASS, SOIL, ROCK, FOLIAGE, SKIN = range(14)

# Palette entries: colour (multiplied by the instance's faction paint) and surface kind.
PAL = {
    'paint':  ((.88, .90, .84), ARMOR),   # faction-painted armour
    'edge':   ((.72, .74, .68), ARMOR),   # secondary painted plates
    'dark':   ((.22, .23, .22), ARMOR),   # unpainted dark fittings
    'steel':  ((.50, .53, .52), ARMOR),   # bare steel, tools
    'rubber': ((.15, .15, .15), RUBBER),
    'glass':  ((.30, .48, .58), GLASS),
    'optic':  ((.20, .60, .70), GLASS),
    'lamp':   ((.98, .90, .68), GLASS),
    'tail':   ((.85, .28, .16), GLASS),
    'canvas': ((.78, .76, .62), FABRIC),
    'sheet':  ((.84, .86, .80), SHEET),   # painted sheet metal (soft-skin vehicles)
    'grille': ((.12, .12, .12), ARMOR),
    'brass':  ((.62, .52, .30), ARMOR),
    'wood':   ((.42, .31, .20), PLAIN),
    'polymer':((.26, .27, .25), ARMOR),
    # soldiers: uniform and helmet cover take the faction tint; skin is exempt from tinting in the shader
    'cloth':  ((.86, .87, .80), FABRIC),
    'cloth2': ((.70, .72, .64), FABRIC),
    'webbing':((.46, .47, .40), FABRIC),
    'skin':   ((.80, .62, .48), SKIN),
    'boot':   ((.17, .15, .13), RUBBER),
    'glove':  ((.24, .23, .21), FABRIC),
    'hardhat':((.86, .70, .36), PLAIN),
    # tanks (build_tanks.py, 2026-11-20): 'trim' parts live in the team-colour trim meshes (white x the team colour);
    # 'glow' is exempt from the instance tint (SKIN surface), so lenses stay cyan and glow where the instance emits
    'trim':   ((.96, .96, .94), ARMOR),
    'glow':   ((.55, .95, 1.0), SKIN),
}


class Asset:
    """One exported mesh, built from parts in a single bmesh. A face int layer stores the palette key."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mat = self.bm.faces.layers.int.new('pal')
        self.bone_layer = self.bm.faces.layers.int.new('bone')
        self.bone = 0      # parts built while set are rigidly bound to this deform bone (skinned assets)
        self.keys = list(PAL.keys())

    # -------------------------------------------------------------- parts
    def _tag(self, faces, key):
        idx = self.keys.index(key)
        for f in faces:
            f[self.mat] = idx
            f[self.bone_layer] = self.bone

    def ellipsoid(self, c, r, key='cloth', segs=12, rings=8):
        """Ellipsoid centred at c with radii r (organic forms: heads, muscles, padding)."""
        before = set(self.bm.faces)
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=segs, v_segments=rings, radius=1)
        for v in res['verts']:
            v.co = Vector((c[0] + v.co.x * r[0], c[1] + v.co.y * r[1], c[2] + v.co.z * r[2]))
        faces = [f for f in self.bm.faces if f not in before]
        return self._finish(faces, key, 0)

    def limb(self, p0, p1, r0, r1, key='cloth', segs=14):
        """A tapered limb segment between two points with rounded joint caps."""
        d = Vector(p1) - Vector(p0)
        self.cyl(p0, d, r0, r1, d.length, key, segs, bevel=0)
        self.ellipsoid(p0, (r0, r0, r0), key, segs, 6)
        return self

    def _new(self, before):
        return [f for f in self.bm.faces if f.index < 0 or f not in before]

    def _finish(self, geom_faces, key, bevel):
        self._tag(geom_faces, key)
        if bevel > 0:
            edges = {e for f in geom_faces for e in f.edges}
            sharp = [e for e in edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(30)]
            if sharp:
                res = bmesh.ops.bevel(self.bm, geom=sharp, offset=bevel, offset_type='OFFSET', segments=1,
                                      profile=.5, affect='EDGES', clamp_overlap=True)
                self._tag(res['faces'], key)
        return self

    def box(self, c, s, key='paint', bevel=.006, taper=None):
        """Centre c, full size s. taper=(sx, sy) scales the top face (sloped sides)."""
        before = set(self.bm.faces)
        r = bmesh.ops.create_cube(self.bm, size=1)
        vs = r['verts']
        for v in vs:
            x, y, z = v.co
            if taper and z > 0:
                x *= taper[0]; y *= taper[1]
            v.co = Vector((c[0] + x * s[0], c[1] + y * s[1], c[2] + z * s[2]))
        faces = [f for f in self.bm.faces if f not in before]
        return self._finish(faces, key, bevel)

    def prism(self, pts, axis, a, b, key='paint', bevel=.006, inset=None):
        """Extrude a closed 2D profile. axis 'x': pts are (y, z), solid spans x in [a, b] (side profile).
        axis 'z': pts are (x, y), spans z in [a, b] (plan outline); inset scales the top (sloped walls)."""
        before = set(self.bm.faces)
        def P(p, t):
            if axis == 'x': return Vector((t, p[0], p[1]))
            if axis == 'y': return Vector((p[0], t, p[1]))
            return Vector((p[0], p[1], t))
        bottom = [self.bm.verts.new(P(p, a)) for p in pts]
        if axis == 'z' and inset:
            cx = sum(p[0] for p in pts) / len(pts); cy = sum(p[1] for p in pts) / len(pts)
            top = [self.bm.verts.new(P((cx + (p[0] - cx) * inset[0], cy + (p[1] - cy) * inset[1]), b)) for p in pts]
        else:
            top = [self.bm.verts.new(P(p, b)) for p in pts]
        n = len(pts)
        self.bm.faces.new(list(reversed(bottom)))
        self.bm.faces.new(top)
        for i in range(n):
            j = (i + 1) % n
            self.bm.faces.new((bottom[i], bottom[j], top[j], top[i]))
        faces = [f for f in self.bm.faces if f not in before]
        bmesh.ops.recalc_face_normals(self.bm, faces=faces)
        return self._finish(faces, key, bevel)

    def cyl(self, c, axis, r1, r2, length, key='steel', segs=16, bevel=.003, caps=True):
        """Cylinder/cone from c along axis ('x','y','z' or a Vector) for length; r1 at c, r2 at the far end."""
        before = set(self.bm.faces)
        d = Vector({'x': (1, 0, 0), 'y': (0, 1, 0), 'z': (0, 0, 1)}[axis]) if isinstance(axis, str) else Vector(axis).normalized()
        rot = Vector((0, 0, 1)).rotation_difference(d).to_matrix().to_4x4()
        m = Matrix.Translation(Vector(c) + d * length * .5) @ rot
        bmesh.ops.create_cone(self.bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r1, radius2=r2,
                              depth=length, matrix=m)
        faces = [f for f in self.bm.faces if f not in before]
        return self._finish(faces, key, bevel)

    def beam(self, p0, p1, r, key='steel', segs=6):
        d = Vector(p1) - Vector(p0)
        return self.cyl(p0, d, r, r, d.length, key, segs, bevel=0)

    def lathe(self, profile, axis, key='steel', segs=24, bevel=0, center=(0, 0, 0)):
        """Revolve (radius, along) points about axis through center: wheels, hubs, barrels."""
        before = set(self.bm.faces)
        d = Vector({'x': (1, 0, 0), 'y': (0, 1, 0), 'z': (0, 0, 1)}[axis])
        rot = Vector((0, 0, 1)).rotation_difference(d).to_matrix()
        rings = []
        for (rad, t) in profile:
            if rad < 1e-5:   # a pole: one vertex, joined with triangles
                rings.append([self.bm.verts.new(Vector(center) + rot @ Vector((0, 0, t)))] * segs)
                continue
            ring = []
            for k in range(segs):
                a = k / segs * math.tau
                ring.append(self.bm.verts.new(Vector(center) + rot @ Vector((math.cos(a) * rad, math.sin(a) * rad, t))))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for k in range(segs):
                kk = (k + 1) % segs
                quad = (rings[i][k], rings[i][kk], rings[i + 1][kk], rings[i + 1][k])
                uniq = []
                for v in quad:
                    if v not in uniq: uniq.append(v)
                if len(uniq) >= 3: self.bm.faces.new(uniq)
        if profile[0][0] > 1e-4: self.bm.faces.new(list(reversed(rings[0])))
        if profile[-1][0] > 1e-4: self.bm.faces.new(rings[-1])
        faces = [f for f in self.bm.faces if f not in before]
        bmesh.ops.recalc_face_normals(self.bm, faces=faces)
        return self._finish(faces, key, bevel)

    def mirror_x(self, build):
        """Run build(sign) for both sides."""
        for s in (-1, 1): build(s)
        return self

    # -------------------------------------------------------------- bake + export
    def export(self, path, ao_radius=.09, ao_rays=20, ao_strength=.62, ground_ao=None):
        bm = self.bm
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
        bm.normal_update()
        bvh = BVHTree.FromBMesh(bm)
        # Fixed, cosine-weighted hemisphere directions about +Z (deterministic builds); each vertex turns them
        # onto its normal. Cosine weighting is the proper ambient integral: grazing rays (which hit the next
        # part over on almost any flat deck) count for little, rays toward the sky for a lot.
        rnd = random.Random(7)
        dirs = []
        for k in range(ao_rays):
            u1, u2 = (k + rnd.random()) / ao_rays, rnd.random()
            r, phi = math.sqrt(u1), 2 * math.pi * u2
            dirs.append(Vector((r * math.cos(phi), r * math.sin(phi), math.sqrt(max(0., 1 - u1)))))
        cos_split = math.cos(math.radians(38))
        verts, index, lookup, ao_cache = [], [], {}, {}
        # Hits closer than this are coincident or touching geometry (a slab laid on a deck, a band on a drum):
        # not occlusion. Without it, coplanar roof decks baked to near-black.
        ao_min = max(.004, ao_radius * .06)

        def corner_normal(v, f):
            n = Vector()
            for g in v.link_faces:
                if g.normal.dot(f.normal) >= cos_split:
                    n += g.normal * max(g.calc_area(), 1e-9)
            return n.normalized() if n.length > 0 else f.normal

        def occlusion(p, n):
            key = (round(p.x, 4), round(p.y, 4), round(p.z, 4), round(n.x, 2), round(n.y, 2), round(n.z, 2))
            if key in ao_cache: return ao_cache[key]
            origin = p + n * .0015
            basis = Vector((0, 0, 1)).rotation_difference(n) if n.length > 0 else None
            hit = 0.0
            for d in dirs:
                w = basis @ d if basis is not None else d
                loc, _, _, dist = bvh.ray_cast(origin, w, ao_radius)
                if loc is not None and dist > ao_min: hit += 1 - (dist - ao_min) / (ao_radius - ao_min)
            o = hit / len(dirs)
            # Sky-facing faces always see most of the sky: never let a deck, roof or pad bake dark.
            if n.z > .5: o = min(o, .30 + (1 - n.z) * .5)
            if ground_ao is not None:   # vehicles sit on the ground: darken the underside and lower flanks
                o = max(o, max(0., 1 - (p.z - ground_ao) / .12) * .55 * max(0., -n.z * .5 + .5))
            ao_cache[key] = o
            return o

        for f in bm.faces:
            col, surf = PAL[self.keys[f[self.mat]]]
            bone = f[self.bone_layer]
            for v in f.verts:
                n = corner_normal(v, f)
                ao = occlusion(v.co, n)
                shade = 1 - ao * ao_strength
                c = tuple(max(0, min(255, int(round(ch * shade * 255)))) for ch in col)
                key = (v.index, round(n.x, 3), round(n.y, 3), round(n.z, 3), c, surf, bone)
                i = lookup.get(key)
                if i is None:
                    i = len(verts); lookup[key] = i
                    verts.append((v.co.copy(), n, c, surf, bone))
                index.append(i)
        with open(path, 'wb') as fh:
            fh.write(b'SEM1'); fh.write(struct.pack('<II', len(verts), len(index)))
            for p, _, _, _, _ in verts: fh.write(struct.pack('<3f', p.x, p.z, p.y))
            for _, n, _, _, _ in verts: fh.write(struct.pack('<3f', n.x, n.z, n.y))
            for _, _, c, _, _ in verts: fh.write(struct.pack('<4B', c[0], c[1], c[2], 255))
            for _, _, _, s, _ in verts: fh.write(struct.pack('<f', float(s)))
            # uv0.x = deform bone index for skinned assets (0 for rigid models).
            for _, _, _, _, b in verts: fh.write(struct.pack('<2f', float(b), 0.))
            fh.write(struct.pack('<%dI' % len(index), *index))
        self.baked = verts, index
        bm.free()
        return len(verts), len(index) // 3

    def preview_object(self, collection, armature=None, bone_names=None):
        """After export: a Blender object of the baked mesh (vertex colours; skinned to armature if given)."""
        import bpy
        verts, index = self.baked
        me = bpy.data.meshes.new(self.name)
        me.from_pydata([tuple(v[0]) for v in verts], [], [tuple(index[i:i + 3]) for i in range(0, len(index), 3)])
        col = me.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
        for i, v in enumerate(verts): col.data[i].color = (v[2][0] / 255, v[2][1] / 255, v[2][2] / 255, 1)
        me.update()
        ob = bpy.data.objects.new(self.name, me)
        collection.objects.link(ob)
        if armature is not None and bone_names:
            groups = [ob.vertex_groups.new(name=n) for n in bone_names]
            for i, v in enumerate(verts): groups[v[4]].add([i], 1.0, 'REPLACE')
            mod = ob.modifiers.new('Rig', 'ARMATURE'); mod.object = armature
            ob.parent = armature
        return ob
