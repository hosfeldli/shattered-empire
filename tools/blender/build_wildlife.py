# Birds for the ambient wildlife system: one small body with wings up and wings down (two meshes the
# game alternates for a flap). Size in game units (a crow-sized bird is ~0.04 across the wings).
#   live:      exec(open(path).read(), {"__name__": "__main__", "__file__": path, "SE_OUT": models_dir})
#   headless:  "<blender.exe>" -b --factory-startup --python-exit-code 1 --python tools/blender/build_wildlife.py -- <models dir>
import sys, os, importlib
HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else r"D:/Projects/shattered_empires/tools/blender"
sys.path.insert(0, HERE)
import se_meshkit; importlib.reload(se_meshkit)
from se_meshkit import Asset, PAL, PLAIN
if 'SE_OUT' in globals(): OUT = SE_OUT
elif '--' in sys.argv: OUT = sys.argv[sys.argv.index('--') + 1]
else: OUT = os.path.join(os.getcwd(), 'out')
PAL['feather'] = ((.16, .15, .14), PLAIN)
PAL['beak'] = ((.55, .45, .25), PLAIN)

def bird_with_pose(name, lift):
    import bmesh
    a = Asset(name)
    a.ellipsoid((0, 0, 0), (.0035, .009, .0035), 'feather', 8, 6)
    a.ellipsoid((0, .009, .001), (.0026, .003, .0026), 'feather', 6, 4)
    a.cyl((0, .011, .001), 'y', .001, 0, .003, 'beak', segs=5, bevel=0)
    a.prism([(0, -.009), (.004, -.014), (-.004, -.014)], 'z', -.0004, .0004, 'feather', bevel=0)
    for s in (-1, 1):
        before = set(a.bm.verts)
        a.prism([(s * .002, .004), (s * .021, -.002), (s * .002, -.004)], 'z', -.0005, .0005, 'feather', bevel=0)
        for v in a.bm.verts:
            if v not in before: v.co.z += abs(v.co.x) * lift      # wings fold up (lift > 0) or sweep down
    return a.export(os.path.join(OUT, name + '.bytes'), ao_radius=.004, ao_rays=6, ao_strength=.3)

print('[se] BirdUp', bird_with_pose('BirdUp', .85))
print('[se] BirdDown', bird_with_pose('BirdDown', -.45))

def bird_perched(name):
    # wings folded along the back, body tilted up a little, short legs
    a = Asset(name)
    a.ellipsoid((0, 0, .004), (.0034, .0085, .0036), 'feather', 8, 6)
    a.ellipsoid((0, .0085, .0068), (.0025, .0029, .0025), 'feather', 6, 4)
    a.cyl((0, .0108, .0068), 'y', .0009, 0, .0028, 'beak', segs=5, bevel=0)
    a.prism([(0, -.008), (.0032, -.0135), (-.0032, -.0135)], 'z', .0028, .0034, 'feather', bevel=0)
    for s in (-1, 1):
        a.prism([(s * .0030, .005), (s * .0036, -.004), (s * .0016, -.010)], 'z', .0052, .0062, 'feather', bevel=0)
        a.cyl((s * .0012, -.0005, 0), 'z', .00035, .00035, .0012, 'beak', segs=4, bevel=0)
    return a.export(os.path.join(OUT, name + '.bytes'), ao_radius=.004, ao_rays=6, ao_strength=.3)

print('[se] BirdPerch', bird_perched('BirdPerch'))
