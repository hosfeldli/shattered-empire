shader_type spatial;
render_mode unshaded;
#include "res://shaders/visibility_fields.gdshaderinc"
varying vec3 world_position;
void vertex() { world_position=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz; }
void fragment() { ALBEDO=fog_ink(world_position.xz); }
