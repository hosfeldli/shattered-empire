"""Editable native military kit. Blender Z-up, +X forward; glTF converts to Godot Y-up."""
import bpy
import math
from pathlib import Path
from mathutils import Vector
OUT=Path(__file__).resolve().parents[2]/'godot/assets/units'
OUT.mkdir(parents=True,exist_ok=True)
colors={'olive':(.33,.35,.25,1),'steel':(.47,.49,.52,1),'char':(.13,.12,.11,1),
        'plaster':(.8,.76,.66,1),'timber':(.46,.34,.23,1),'glass':(.3,.4,.47,1),'canvas':(.74,.68,.55,1)}
mats={}
for key,color in colors.items():
    mat=bpy.data.materials.new(key);mat.diffuse_color=color;mats[key]=mat

def box(name,loc,size,material='olive',bevel=.001):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc)
    ob=bpy.context.object;ob.name=name;ob.dimensions=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    ob.data.materials.append(mats[material])
    if bevel:
        mod=ob.modifiers.new('Edge bevel','BEVEL');mod.width=bevel;mod.segments=1
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return ob

def cylinder(name,loc,radius,length,material='steel',axis='Z',segments=10):
    bpy.ops.mesh.primitive_cylinder_add(vertices=segments,radius=radius,depth=length,location=loc)
    ob=bpy.context.object;ob.name=name;ob.data.materials.append(mats[material])
    if axis=='X':ob.rotation_euler.y=math.pi/2
    elif axis=='Y':ob.rotation_euler.x=math.pi/2
    return ob

def beam(name,a,b,width,material='olive'):
    a,b=Vector(a),Vector(b)
    ob=box(name,(a+b)*.5,(width,width,(b-a).length),material,.0006)
    ob.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler()
    return ob

def reset():
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)

def save(name):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(OUT/f'{name}.glb'),export_format='GLB',export_yup=True,export_materials='EXPORT')

for pose,stride in [('infantry_idle',0),('infantry_walk_0',1),('infantry_walk_1',-1),('infantry_cover',0)]:
    reset();cover=pose.endswith('cover');hip=.044 if cover else .067;shoulder=hip+.035
    box('Jacket',(0,0,hip+.016),(.035,.032,.04))
    box('Webbing',(-.016,0,hip+.02),(.008,.038,.022),'canvas',.0005)
    for side in [-1,1]:
        y=side*.011;step=side*stride*.016
        knee=(-.012 if cover else step*.5,y,hip*.48)
        foot=(.018 if cover else step,y,.008)
        beam('Upper leg',(0,y,hip),knee,.013)
        beam('Lower leg',knee,foot,.012)
        box('Boot',(foot[0]+.006,y,.005),(.025,.015,.01),'char',.0005)
        hand=(.033,side*.014,shoulder-.025)
        elbow=(.008,side*.024,shoulder-.017)
        beam('Upper sleeve',(0,side*.022,shoulder),elbow,.012)
        beam('Lower sleeve',elbow,hand,.01)
        box('Hand',hand,(.009,.009,.009),'plaster',.0003)
    cylinder('Face',(.002,0,shoulder+.02),.012,.023,'plaster',segments=8)
    cylinder('Helmet',(.001,0,shoulder+.033),.016,.012,'olive',segments=10)
    box('Rifle stock',(.035,0,shoulder-.023),(.035,.009,.011),'timber',.0004)
    cylinder('Rifle barrel',(.064,0,shoulder-.02),.002,.028,'steel','X',6)
    save(pose)

reset()
for side in [-1,1]:
    box('Track belt',(0,side*.075,.027),(.32,.044,.054),'char',.004)
    for x in [-.12,-.072,-.024,.024,.072,.12]:
        cylinder('Road wheel',(x,side*.099,.029),.023,.008,'steel','Y',10)
    for x in range(12):
        box('Tread shoe',(-.145+x*.026,side*.075,.055),(.015,.047,.007),'steel',.0004)
box('Sloped armored hull',(0,0,.074),(.29,.15,.061),'olive',.009)
box('Engine deck',(-.095,0,.108),(.08,.125,.014),'steel',.001)
for y in [-.04,-.02,0,.02,.04]:box('Cooling grille',(-.096,y,.117),(.07,.005,.003),'char',0)
box('Driver hatch',(.085,0,.108),(.045,.055,.012),'olive',.002)
save('tank_hull')
reset()
box('Armored turret',(-.015,0,.133),(.135,.115,.06),'olive',.012)
cylinder('Main gun',(.117,0,.137),.009,.15,'steel','X',10)
cylinder('Muzzle',(.195,0,.137),.012,.022,'char','X',8)
cylinder('Cupola',(-.03,-.018,.169),.025,.015,'olive',segments=10)
box('Optics',(.018,.038,.168),(.016,.018,.012),'glass',.001)
save('tank_turret')

reset()
box('Jeep chassis',(0,0,.035),(.24,.125,.028),'steel',.003)
for x in [-.075,.08]:
    for y in [-.071,.071]:cylinder('Rubber tire',(x,y,.029),.032,.025,'char','Y',12)
box('Hood',(.072,0,.071),(.105,.12,.045),'olive',.005)
box('Cab',(-.006,0,.084),(.07,.115,.08),'olive',.004)
box('Windshield',(.031,0,.104),(.006,.095,.035),'glass',.001)
box('Canvas cargo',(-.079,0,.081),(.085,.115,.075),'canvas',.004)
for y in [-.044,.044]:cylinder('Headlamp',(.127,y,.07),.009,.006,'glass','X',8)
save('scout_vehicle')

reset()
for y in [-.06,.06]:cylinder('Gun carriage wheel',(0,y,.038),.04,.018,'char','Y',12)
box('Carriage',(0,0,.056),(.11,.1,.03),'olive',.003)
cylinder('Gun barrel',(.1,0,.095),.012,.21,'steel','X',12)
box('Gun shield',(.015,0,.09),(.015,.13,.09),'olive',.002)
for y in [-.04,.04]:beam('Split trail',(-.025,0,.05),(-.18,y,.012),.018)
save('artillery_gun')

reset()
body=cylinder('Fuselage',(0,0,0),.03,.35,'steel','X',12);body.scale.y=.7
box('Cockpit',(.08,0,.028),(.09,.036,.022),'glass',.005)
for side in [-1,1]:
    mesh=bpy.data.meshes.new('Swept wing')
    mesh.from_pydata([(.075,side*.015,0),(-.06,side*.215,-.004),(-.11,side*.215,-.004),(-.055,side*.015,0)],[],[(0,1,2,3),(3,2,1,0)])
    ob=bpy.data.objects.new('Swept wing',mesh);bpy.context.collection.objects.link(ob);mesh.materials.append(mats['steel'])
    box('Tailplane',(-.14,side*.05,.012),(.06,.12,.008),'steel',.001)
box('Vertical tail',(-.14,0,.044),(.06,.008,.07),'olive',.001)
save('aircraft')
print('LWE military kit exported:',OUT)
