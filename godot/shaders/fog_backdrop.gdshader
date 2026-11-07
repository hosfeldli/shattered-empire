shader_type spatial;
render_mode unshaded;
#include "res://shaders/visibility_fields.gdshaderinc"
varying vec3 world_position;
void vertex() { world_position=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz; }
// The backdrop lies below the terrain. Sample the cloud field where the line of sight crosses
// ground level (pitch 60 degrees), so its clouds continue the terrain's without a visible offset.
void fragment() { ALBEDO=fog_ink(world_position.xz+vec2(0.0,-world_position.y*.57735027)); }
