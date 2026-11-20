# Contact sheet of building destruction stages (what Unity loads): one row per building, columns s0..s3 (+ LOD).
#   "<blender.exe>" -b --factory-startup --python tools/blender/preview_buildings.py -- <models-dir> <out.png> <lod:0|1> name...
import bpy, sys, os, struct, math
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
src, out_png, lod, names = args[0], args[1], args[2] == '1', args[3:]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def load(name):
    p = os.path.join(src, name + '.bytes')
    if not os.path.exists(p): return None
    data = open(p, 'rb').read()
    v, n = struct.unpack_from('<II', data, 4)
    o = 12
    pos = [struct.unpack_from('<3f', data, o + i * 12) for i in range(v)]; o += v * 24
    col = [struct.unpack_from('<4B', data, o + i * 4) for i in range(v)]; o += v * 4 + v * 4 + v * 8
    idx = struct.unpack_from('<%dI' % n, data, o)
    me = bpy.data.meshes.new(name)
    me.from_pydata([(p[0], p[2], p[1]) for p in pos], [], [(idx[i], idx[i + 2], idx[i + 1]) for i in range(0, n, 3)])
    attr = me.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
    for i, c in enumerate(col): attr.data[i].color = (c[0] / 255, c[1] / 255, c[2] / 255, 1)
    me.update()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob

cols = ['_s0', '_s1', '_s2', '_s3'] + (['_s0_lo', '_s2_lo'] if lod else [])
step = 1.35
for r, name in enumerate(names):
    for c, suf in enumerate(cols):
        ob = load(name + suf)
        if ob is None: continue
        ob.location = (c * step, -r * step, 0)
        ob.rotation_euler = (0, 0, math.radians(200))
# ground plane
bpy.ops.mesh.primitive_plane_add(size=1, location=((len(cols) - 1) * step / 2, -(len(names) - 1) * step / 2, -.002))
pl = bpy.context.active_object; pl.scale = (len(cols) * step + 1, len(names) * step + 1, 1)
mat = bpy.data.materials.new('g'); mat.diffuse_color = (.42, .40, .34, 1); pl.data.materials.append(mat)
cam_data = bpy.data.cameras.new('cam'); cam_data.type = 'ORTHO'
w, h = len(cols) * step, len(names) * step
vis_w, vis_h = w + .3, h * .66 + .7
cam_data.ortho_scale = max(vis_w, vis_h)
cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam)
cx, cy = (len(cols) - 1) * step / 2, -(len(names) - 1) * step / 2
pitch = math.radians(50)
cam.location = (cx, cy - 20 * math.sin(pitch) + .25, 20 * math.cos(pitch))
cam.rotation_euler = (pitch, 0, 0)
scene.camera = cam
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_cavity = True; sh.show_shadows = True
scene.display.shadow_shift = .1
scene.render.resolution_x = 340 * len(cols)
scene.render.resolution_y = int(scene.render.resolution_x * vis_h / vis_w)
scene.render.filepath = out_png
bpy.ops.render.render(write_still=True)
print('[se] preview', out_png)
