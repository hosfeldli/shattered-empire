"""Authored LWE residential kit. Run with Blender --background --python this_file.

Meters are represented in hex-radius units. Material slot names are the native shared library
contract; glTF materials are replaced on import. No runtime Blender dependency.
"""
import bpy
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'godot/assets/buildings'
OUT.mkdir(parents=True, exist_ok=True)
PALETTE = {'brick': (.56,.31,.24,1), 'plaster': (.8,.76,.66,1),
           'stone': (.64,.61,.56,1), 'timber': (.46,.34,.23,1),
           'roof_tile': (.52,.29,.21,1), 'roof_slate': (.31,.33,.36,1),
           'glass': (.3,.4,.47,1), 'steel': (.47,.49,.52,1)}
materials = {}
for name, color in PALETTE.items():
    m = bpy.data.materials.new(name)
    m.diffuse_color = color
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = color
    bs.inputs['Roughness'].default_value = .85 if name != 'glass' else .12
    materials[name] = m


def box(name, loc, size, mat, bevel=.003):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    ob = bpy.context.object
    ob.name = name
    ob.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ob.data.materials.append(materials[mat])
    if bevel:
        mod = ob.modifiers.new('Soft masonry edges', 'BEVEL')
        mod.width = bevel
        mod.segments = 1
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return ob


def roof(w, d, eaves, rise, mat):
    # Blender Z up; glTF exporter converts to Godot Y up.
    verts = [(-w/2,-d/2,eaves),(w/2,-d/2,eaves),(-w/2,d/2,eaves),
             (w/2,d/2,eaves),(0,-d/2,eaves+rise),(0,d/2,eaves+rise)]
    faces = [(0,4,5,2),(1,3,5,4),(0,1,4),(2,5,3),(0,2,3,1)]
    mesh = bpy.data.meshes.new('Gabled roof')
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(materials[mat])
    ob = bpy.data.objects.new('Roof with deep eaves', mesh)
    bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    ob.select_set(False)


def window(x, y, z, side=False):
    dims = (.004,.062,.075) if side else (.062,.004,.075)
    box('Recessed glazing', (x,y,z), dims, 'glass', 0)
    for off in [-1,1]:
        size = (.008,.075,.009) if side else (.075,.008,.009)
        box('Lintel and sill', (x,y,z+off*.042), size, 'stone', .001)
    box('Window mullion', (x,y,z), (.006,.006,.075), 'timber', 0)


for variant in range(3):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    floors = 2 if variant == 2 else 1
    w, d, h = .38 + .03*variant, .47, .22*floors
    wall = 'brick' if variant == 1 else 'plaster'
    box('Stone footing', (0,0,.022), (w+.025,d+.025,.044), 'stone')
    box('Main inhabited volume', (0,0,.04+h/2), (w,d,h), wall)
    roof(w+.055,d+.055,.04+h,.125,'roof_slate' if variant == 2 else 'roof_tile')
    box('Chimney shaft', (.105,.115,.10+h), (.045,.052,.20), 'brick', .002)
    box('Chimney cap', (.105,.115,.205+h), (.058,.065,.016), 'stone', .001)
    box('Door', (0,-d/2-.003,.105), (.058,.008,.13), 'timber', .001)
    box('Door lintel', (0,-d/2-.005,.177), (.08,.018,.014), 'stone', .001)
    for z in [.035,.023,.011]:
        box('Entrance steps', (0,-d/2-.035-(.035-z)*1.2,z/2), (.09,.075,z), 'stone', .001)
    for floor in range(floors):
        z = .16 + floor*.22
        for x in [-w*.29,w*.29]:
            window(x,-d/2-.006,z)
            window(x,d/2+.006,z)
        for y in [-.12,.12]:
            window(-w/2-.006,y,z,True)
            window(w/2+.006,y,z,True)
    # Raised eaves boards and rain gutters remain legible at operational zoom.
    for x in [-1,1]:
        box('Fascia', (x*(w/2+.02),0,h+.039), (.018,d+.055,.025), 'timber', .001)
        box('Drainpipe', (x*(w/2+.006),d/2-.018,h/2+.04), (.009,.012,h), 'steel', 0)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(OUT / f'residential_{variant}.glb'),
        export_format='GLB', export_materials='EXPORT', export_yup=True,
        export_tangents=True, export_extras=True)
    if variant == 2:
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(__file__).with_name('residential.blend')))
print('LWE residential kit exported:', OUT)
