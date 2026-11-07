shader_type spatial;
render_mode blend_mix, cull_back, depth_draw_opaque, specular_schlick_ggx;
#include "res://shaders/weather_clouds.gdshaderinc"
#include "res://shaders/visibility_fields.gdshaderinc"
uniform sampler2D vis_bits : filter_nearest;
uniform float vis_on=1.0;
uniform vec2 world_cells=vec2(128.0);
uniform sampler2D water_data : filter_nearest, hint_default_black;
uniform float water_data_ready=0.0;
uniform sampler2D fluid_height : filter_linear, repeat_disable, hint_default_black;
uniform vec2 fluid_origin=vec2(0.0);
uniform float fluid_extent=14.4;
uniform float fluid_texel=.0208333;
uniform float fluid_active=0.0;
uniform float fluid_scale=1.0;
uniform vec2 water_wind=vec2(.4,0.0);
uniform float water_time=0.0;
uniform float water_detail=1.0;
uniform sampler2D depth_texture : hint_depth_texture, repeat_disable, filter_nearest;
varying vec3 world_position;
float water_detail_floor() { return .45+.55*water_detail; }

ivec2 water_cell(vec2 p) {
    float x=.577350269*p.x-p.y/3.0, z=2.0/3.0*p.y;
    vec3 rounded=round(vec3(x,-x-z,z));
    vec3 delta=abs(rounded-vec3(x,-x-z,z));
    if(delta.x>delta.y && delta.x>delta.z) rounded.x=-rounded.y-rounded.z;
    else if(delta.y>delta.z) rounded.y=-rounded.x-rounded.z;
    else rounded.z=-rounded.x-rounded.y;
    int row=int(rounded.z); int q=int(rounded.x)+(row-(row & 1))/2;
    int width=int(world_cells.x); q=((q%width)+width)%width;
    return ivec2(q,clamp(row,0,int(world_cells.y)-1));
}
vec4 water_at(vec2 p) { return texelFetch(water_data,water_cell(p),0); }
float visible_water(vec2 p) {
    if(vis_on<.5) return 1.0;
    ivec2 cell=water_cell(p); ivec2 packed=ivec2(cell.x>>3,cell.y);
    ivec2 bounds=textureSize(vis_bits,0);
    if(packed.x>=bounds.x || packed.y>=bounds.y) return 0.0;
    int bits=int(texelFetch(vis_bits,packed,0).r*255.0+.5);
    return float((bits>>(cell.x & 7)) & 1);
}
vec2 fluid_uv(vec2 p) {
    float period=world_cells.x*1.732050808;
    float dx=p.x-fluid_origin.x;
    dx-=round((dx-fluid_extent*.5)/period)*period;
    return vec2(dx,p.y-fluid_origin.y)/fluid_extent;
}
float fluid(vec2 p) {
    vec2 uv=fluid_uv(p);
    float edge=min(min(uv.x,uv.y),min(1.0-uv.x,1.0-uv.y));
    return texture(fluid_height,clamp(uv,vec2(0.0),vec2(1.0))).r*smoothstep(0.0,.16,edge)*fluid_active*fluid_scale;
}
float swell(vec2 p,vec4 data) {
    float period=world_cells.x*1.732050808;
    float k1=6.2831853*max(1.0,round(period*.23))/period;
    float k2=6.2831853*max(1.0,round(period*.48))/period;
    float wave=sin(p.x*k1+p.y*.91-water_time*1.65)*.0025+sin(p.x*k2-p.y*1.67-water_time*2.31)*.0012;
    float river=step(.75,data.b);
    return wave*(.3+min(1.5,length(water_wind)))*mix(1.0,0.0,river)*smoothstep(.03,.3,data.a);
}
vec2 capillary_slope(vec2 position,vec2 flow,float footprint) {
    vec2 slope=vec2(0.0);
    float period=world_cells.x*1.732050808;
    for(int i=0;i<7;i++) {
        float angle=float(i)*2.3999632;
        vec2 direction=vec2(cos(angle),sin(angle));
        float wavelength=.065+.028*float(i);
        float k=6.2831853/wavelength;
        vec2 wave=direction*k;
        wave.x=round(wave.x*period/6.2831853)*6.2831853/period;
        float strength=(.00008+.00004*min(1.0,length(water_wind)))*smoothstep(2.0*footprint,5.0*footprint,wavelength);
        float phase=dot(wave,position-flow*water_time*.25)-sqrt(9.8*k)*water_time*.12+float(i)*1.71;
        slope+=wave*cos(phase)*strength;
    }
    return slope;
}
void vertex() {
    vec3 original=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;
    if(water_data_ready>.5) VERTEX.y+=swell(original.xz,water_at(original.xz));
    world_position=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;
}
void fragment() {
    vec4 data=water_at(world_position.xz);
    vec2 flow=(data.rg*2.0-1.0)*step(.75,data.b);
    vec2 advected=world_position.xz-flow*water_time*.55;
    vec2 p=advected/weather_extent*vec2(world_cells.x*40.0,world_cells.y*34.0);
    float ripples=cloud_noise(p,world_cells.x*40.0);
    float cross_ripple=cloud_noise(p*1.7+vec2(0,water_time*.3),world_cells.x*40.0*1.7);
    float epsilon=max(.012,fluid_extent*fluid_texel);
    float dx=fluid(world_position.xz+vec2(epsilon,0))-fluid(world_position.xz-vec2(epsilon,0));
    float dz=fluid(world_position.xz+vec2(0,epsilon))-fluid(world_position.xz-vec2(0,epsilon));
    float footprint=max(length(dFdx(world_position.xz)),length(dFdy(world_position.xz)));
    vec2 slope=capillary_slope(world_position.xz,flow,footprint)*water_detail+vec2(dx,dz)/(epsilon*2.0);
    vec3 bump=vec3(-slope.x,1.0,-slope.y);
    NORMAL=normalize((VIEW_MATRIX*vec4(normalize(bump),0.0)).xyz);
    float depth=textureLod(depth_texture,SCREEN_UV,0.0).r;
    vec4 scene=INV_PROJECTION_MATRIX*vec4(SCREEN_UV*2.0-1.0,depth,1.0);
    float thickness=max(0.0,-scene.z/scene.w+VERTEX.z);
    float shore=1.0-smoothstep(.025,.19,thickness);
    float foam=shore*(1.0-step(.75,data.b))*smoothstep(.8,.97,ripples)*.032;
    float river=step(.75,data.b);
    // Sky reflection: the ripple normal tilts the reflected ray between the zenith and the
    // horizon; drifting clouds reflect as soft lighter patches. Strength stays modest so the
    // depth colour still reads through.
    vec3 world_normal=normalize(bump);
    vec3 view_dir=normalize(vec3(0.0,-.866,-.5));
    vec3 reflected=reflect(view_dir,world_normal);
    float horizon=1.0-clamp(reflected.y,0.0,1.0);
    vec3 sky=mix(vec3(.36,.47,.56),vec3(.62,.68,.72),horizon*horizon);
    float overcast=cloud_coverage(world_position.xz);
    sky=mix(sky,vec3(.58,.60,.62),overcast*.7);
    float fresnel=.10+.22*pow(horizon,3.0);
    vec3 color=pow(COLOR.rgb,vec3(2.2))*(.98+.03*ripples);
    // Shallow water near banks shows the bed; deep water absorbs to blue-green.
    float shallow=1.0-smoothstep(.02,.32,thickness);
    color=mix(color,color*vec3(1.25,1.18,.92)+vec3(.018,.016,.008),shallow*.55);
    // Rivers: faint streaks stretched along the current make the flow direction legible.
    if(river>.5) {
        vec2 along=normalize(flow+vec2(1e-4));
        vec2 across=vec2(-along.y,along.x);
        vec2 sp=vec2(dot(world_position.xz,along)*1.6-water_time*.9,dot(world_position.xz,across)*9.0);
        float streak=cloud_noise(sp,world_cells.x*40.0)*cloud_noise(sp*vec2(.5,1.7)+3.1,world_cells.x*40.0);
        color+=vec3(.035,.04,.038)*smoothstep(.25,.6,streak)*water_detail;
    }
    color=mix(color,sky*.42,fresnel*water_detail_floor());
    color=mix(color,vec3(.42,.45,.43),clamp(foam,0.0,.1)*water_detail);
    color*=cloud_shadow(world_position);
    vec2 knowledge=surface_visibility(world_position.xz);
    ALBEDO=remembered_surface(color,knowledge.y)*knowledge.x;
    EMISSION=fog_ink(world_position.xz)*(1.0-knowledge.x);
    ALPHA=1.0;
    ROUGHNESS=mix(.31,.52,foam)+.035*cross_ripple;
    SPECULAR=.12*knowledge.x;
}

void light() {
    float diffuse=max(dot(NORMAL,LIGHT),0.0);
    DIFFUSE_LIGHT+=LIGHT_COLOR*ATTENUATION*diffuse/PI;
    // A restrained solar reflection on the fine pressure/capillary slopes, never white blobs.
    vec3 halfway=normalize(LIGHT+VIEW);
    float reflection=pow(max(dot(NORMAL,halfway),0.0),160.0)*clamp(dot(ALBEDO,vec3(.333))*8.0,0.0,1.0);
    SPECULAR_LIGHT+=LIGHT_COLOR*ATTENUATION*reflection*.035;
}
