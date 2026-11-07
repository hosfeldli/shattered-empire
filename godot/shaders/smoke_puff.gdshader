// Soft smoke and dust puffs. Silhouettes feather by viewing angle and dissolve through drifting
// value noise, so overlapping puffs read as one billowing plume rather than faceted spheres. A
// depth fade softens contact with the ground. Shading is simple sky-from-above lighting.
shader_type spatial;
render_mode blend_mix, depth_draw_never, cull_back, unshaded, shadows_disabled;
uniform vec4 tint : source_color = vec4(.62,.60,.57,1.0);
uniform float opacity = .45;
uniform sampler2D depth_texture : hint_depth_texture, filter_nearest;
varying vec3 world_position;
varying float seed;

float hash3(vec3 p) { return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
float noise3(vec3 p) {
    vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x),mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y);
    float b=mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x),mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y);
    return mix(a,b,f.z);
}
void vertex() {
    world_position=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;
    seed=fract(sin(dot(MODEL_MATRIX[3].xyz,vec3(12.9898,78.233,37.719)))*43758.5453);
}
void fragment() {
    float facing=clamp(dot(NORMAL,VIEW),0.0,1.0);
    vec3 p=world_position*6.0+vec3(seed*17.0,-TIME*.35,seed*9.0);
    float n=noise3(p)*.6+noise3(p*2.3+vec3(TIME*.2,0.0,0.0))*.4;
    float body=smoothstep(.12,.85,facing*.85+n*.55-.2);
    float depth=textureLod(depth_texture,SCREEN_UV,0.0).r;
    vec4 scene=INV_PROJECTION_MATRIX*vec4(SCREEN_UV*2.0-1.0,depth,1.0);
    float contact=smoothstep(0.0,.18,-scene.z/scene.w+VERTEX.z);
    vec3 wn=normalize((INV_VIEW_MATRIX*vec4(NORMAL,0.0)).xyz);
    float light=.70+.30*clamp(wn.y,0.0,1.0)+.12*(n-.5);
    ALBEDO=tint.rgb*COLOR.rgb*light;
    ALPHA=clamp(opacity*body*contact*COLOR.a,0.0,1.0);
}
