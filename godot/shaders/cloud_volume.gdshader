shader_type spatial;
render_mode unshaded, blend_mix, depth_draw_never, cull_disabled, shadows_disabled;
#include "res://shaders/weather_clouds.gdshaderinc"
uniform sampler2D known_tex : filter_nearest, repeat_enable, hint_default_black;
uniform vec2 world_size=vec2(221.7,192.0);
uniform float opacity=.4;
uniform int cloud_steps=7;
varying vec3 world_position;
void vertex() { world_position=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz; }
void fragment() {
    vec3 direction=normalize((INV_VIEW_MATRIX*vec4(-VIEW,0.0)).xyz);
    float density=0.0;
    float illumination=0.0;
    for(int i=0;i<12;i++) {
        if(i>=cloud_steps) break;
        float layer=1.0-(float(i)+.5)/float(cloud_steps);
        vec2 point=world_position.xz+direction.xz*(1.0-layer)*2.4/max(.3,abs(direction.y));
        float sample_density=cloud_density(point,layer);
        float transmission=exp(-density*.32);
        illumination+=sample_density*transmission*(.58+.42*layer);
        density+=sample_density*2.8/float(cloud_steps);
    }
    float known=texture(known_tex,vec2(fract(world_position.x/world_size.x),clamp(world_position.z/world_size.y,0.0,1.0))).r;
    float alpha=(1.0-exp(-density*1.8))*opacity*known;
    vec3 color=mix(vec3(.61,.67,.74),vec3(.99,.97,.90),clamp(illumination/max(density,0.001)*.45,0.0,1.0));
    ALBEDO=color;
    ALPHA=alpha;
}
