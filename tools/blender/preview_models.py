# Renders a contact sheet of the exported SEM1 models (what Unity will load), for authoring review.
#   "<blender.exe>" -b --factory-startup --python tools/blender/preview_models.py -- <models-dir> <out.png> [names...]
import bpy, sys, os, struct, math
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
src, out_png, names = args[0], args[1], args[2:]
files = sorted(f[:-6] for f in os.listdir(src) if f.endswith('.bytes'))
if names: files = [n for n in names if n in files]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def load(name):
    data = open(os.path.join(src, name + '.bytes'), 'rb').read()
    v, n = struct.unpack_from('<II', data, 4)
    o = 12
    pos = [struct.unpack_from('<3f', data, o + i * 12) for i in range(v)]; o += v * 12
    o += v * 12   # normals (Blender recomputes for preview)
    col = [struct.unpack_from('<4B', data, o + i * 4) for i in range(v)]; o += v * 4
    o += v * 4 + v * 8
    idx = struct.unpack_from('<%dI' % n, data, o)
    verts = [(p[0], p[2], p[1]) for p in pos]          # Unity (x,y,z) -> Blender (x,z,y)
    faces = [(idx[i], idx[i + 1], idx[i + 2]) for i in range(0, n, 3)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
    for i, c in enumerate(col): attr.data[i].color = (c[0] / 255, c[1] / 255, c[2] / 255, 1)
    me.update()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob

cols = 5
objs = []
for i, name in enumerate(files):
    ob = load(name)
    ob.dimensions  # force eval
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    size = max(max(c[k] for c in bb) - min(c[k] for c in bb) for k in range(3))
    s = 1.0 / max(size, 1e-3)
    ob.scale = (s, s, s)
    ob.location = ((i % cols) * 1.3, -(i // cols) * 1.3 * 0, -(i // cols) * 1.25)
    ob.rotation_euler = (0, 0, math.radians(-145))
    objs.append(ob)

rows = (len(objs) + cols - 1) // cols
cam_data = bpy.data.cameras.new('cam'); cam_data.type = 'ORTHO'; cam_data.ortho_scale = max(cols * 1.3, rows * 1.25 * 1.6) + .2
cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam)
cx = (cols - 1) * 1.3 / 2; cz = -(rows - 1) * 1.25 / 2
cam.location = (cx, -12, cz + 5.5); cam.rotation_euler = (math.radians(65), 0, 0)
scene.camera = cam
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_cavity = True; sh.show_shadows = True
scene.render.resolution_x = 1800; scene.render.resolution_y = int(1800 * rows * 1.25 / (cols * 1.3)) + 200
scene.render.filepath = out_png
bpy.ops.render.render(write_still=True)
print('[se] preview', out_png)
