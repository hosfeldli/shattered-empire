class_name EnvironmentContext
extends RefCounted
## One CPU weather context shared by activity, smoke and surfaces. Only received weather fields.
var world: WorldState
var columns := 0
var rows := 0
var cell := 8
var rain := PackedByteArray()
var wet := PackedByteArray()
var cloud := PackedByteArray()
var fog:=PackedByteArray()
var storm:=PackedByteArray()
var snow:=PackedByteArray()
var cyclones:Array=[]
var strength:=0.0
var wind_direction:=Vector2.RIGHT
var wind := Vector2.ZERO
var wet_texture:ImageTexture
var wind_texture:ImageTexture


func setup(w: WorldState) -> void:
	world = w
	w.weather_changed.connect(apply)
	w.reset.connect(clear)
	w.welcomed.connect(clear)


func clear() -> void:
	columns = 0; rows = 0; rain.clear(); wet.clear(); cloud.clear(); wind = Vector2.ZERO
	fog.clear(); storm.clear(); snow.clear(); cyclones.clear(); strength=0.0
	wet_texture=null
	wind_texture=null; wind_direction=Vector2.RIGHT
	MaterialLibrary.bind_weather(null,Vector2(221.7,192.0))


func apply(data: Dictionary) -> void:
	columns = int(data.get("cw", 0)); rows = int(data.get("ch", 0)); cell = maxi(1, int(data.get("cell", 8)))
	rain = Marshalls.base64_to_raw(str(data.get("rain", "")))
	wet = Marshalls.base64_to_raw(str(data.get("wet", "")))
	cloud = Marshalls.base64_to_raw(str(data.get("cloud", "")))
	fog=Marshalls.base64_to_raw(str(data.get("fog",""))); storm=Marshalls.base64_to_raw(str(data.get("storm",""))); snow=Marshalls.base64_to_raw(str(data.get("snow","")))
	cyclones=data.get("cy",[])
	var vector: Array = data.get("wind", [0.0,0.0])
	wind = Vector2(cos(float(vector[0])), sin(float(vector[0]))) * float(vector[1])
	wind_direction=Vector2(cos(float(vector[0])),sin(float(vector[0])))
	strength=float(vector[1])
	if columns>0 and rows>0 and wet.size()==columns*rows:
		var image:=Image.create_from_data(columns,rows,false,Image.FORMAT_R8,wet)
		if wet_texture==null or wet_texture.get_width()!=columns or wet_texture.get_height()!=rows:
			wet_texture=ImageTexture.create_from_image(image)
		else: wet_texture.update(image)
		MaterialLibrary.bind_weather(wet_texture,Vector2(columns*cell*HexGrid.SQRT3,rows*cell*1.5))
		var extent:=Vector2(columns*cell*HexGrid.SQRT3,rows*cell*1.5)
		var velocities:=Image.create(columns,rows,false,Image.FORMAT_RGBAF)
		for y in rows:
			for x in columns:
				var value:=wind_at_world((Vector2(x,y)+Vector2.ONE*.5)*Vector2(cell*HexGrid.SQRT3,cell*1.5))/extent
				velocities.set_pixel(x,y,Color(value.x,value.y,0,1))
		if wind_texture==null or wind_texture.get_width()!=columns or wind_texture.get_height()!=rows: wind_texture=ImageTexture.create_from_image(velocities)
		else: wind_texture.update(velocities)


func at_tile(tile: int) -> Dictionary:
	if columns <= 0 or world.grid == null or tile < 0 or tile >= world.grid.n: return {"rain":0.0,"wet":0.0,"cloud":0.0}
	var q := tile % world.grid.w
	var r := tile / world.grid.w
	var index := mini(rows-1, r / cell) * columns + posmod(q / cell, columns)
	return {"rain": _sample(rain,index), "wet":_sample(wet,index), "cloud":_sample(cloud,index),"fog":_sample(fog,index),"storm":_sample(storm,index),"snow":_sample(snow,index)}

func wind_at_world(point:Vector2) -> Vector2:
	if columns<=0 or rows<=0: return Vector2.ZERO
	var position:=Vector2(point.x/(cell*HexGrid.SQRT3),point.y/(cell*1.5))
	var flow:=wind_direction*(.25+strength*.55); flow.y*=.6
	for cyclone in cyclones:
		var delta:=position-Vector2(float(cyclone[1]),float(cyclone[2]))
		delta.x=wrapf(delta.x,-float(columns)*.5,float(columns)*.5)
		var distance:=delta.length(); var radius:=maxf(.01,float(cyclone[3])); var k:=distance/radius
		if k>3.5 or distance<.001: continue
		var velocity:=float(cyclone[4])*.9*k*exp(.5*(1.0-k*k))
		var tangent:=Vector2(-delta.y,delta.x)/distance*float(cyclone[5])
		flow+=tangent*velocity-delta/distance*velocity*.3
	return flow*Vector2(cell*HexGrid.SQRT3,cell*1.5)/5.0


func _sample(data: PackedByteArray, index: int) -> float:
	return data[index] / 255.0 if index >= 0 and index < data.size() else 0.0
