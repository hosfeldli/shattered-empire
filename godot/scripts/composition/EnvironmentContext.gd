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
var wind := Vector2.ZERO
var wet_texture:ImageTexture


func setup(w: WorldState) -> void:
	world = w
	w.weather_changed.connect(apply)
	w.reset.connect(clear)
	w.welcomed.connect(clear)


func clear() -> void:
	columns = 0; rows = 0; rain.clear(); wet.clear(); cloud.clear(); wind = Vector2.ZERO
	wet_texture=null
	MaterialLibrary.bind_weather(null,Vector2(221.7,192.0))


func apply(data: Dictionary) -> void:
	columns = int(data.get("cw", 0)); rows = int(data.get("ch", 0)); cell = maxi(1, int(data.get("cell", 8)))
	rain = Marshalls.base64_to_raw(str(data.get("rain", "")))
	wet = Marshalls.base64_to_raw(str(data.get("wet", "")))
	cloud = Marshalls.base64_to_raw(str(data.get("cloud", "")))
	var vector: Array = data.get("wind", [0.0,0.0])
	wind = Vector2(cos(float(vector[0])), sin(float(vector[0]))) * float(vector[1])
	if columns>0 and rows>0 and wet.size()==columns*rows:
		var image:=Image.create_from_data(columns,rows,false,Image.FORMAT_R8,wet)
		if wet_texture==null or wet_texture.get_width()!=columns or wet_texture.get_height()!=rows:
			wet_texture=ImageTexture.create_from_image(image)
		else: wet_texture.update(image)
		MaterialLibrary.bind_weather(wet_texture,Vector2(columns*cell*HexGrid.SQRT3,rows*cell*1.5))


func at_tile(tile: int) -> Dictionary:
	if columns <= 0 or world.grid == null or tile < 0 or tile >= world.grid.n: return {"rain":0.0,"wet":0.0,"cloud":0.0}
	var q := tile % world.grid.w
	var r := tile / world.grid.w
	var index := mini(rows-1, r / cell) * columns + posmod(q / cell, columns)
	return {"rain": _sample(rain,index), "wet":_sample(wet,index), "cloud":_sample(cloud,index)}


func _sample(data: PackedByteArray, index: int) -> float:
	return data[index] / 255.0 if index >= 0 and index < data.size() else 0.0
