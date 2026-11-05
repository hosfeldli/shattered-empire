shader_type spatial;
render_mode diffuse_burley, specular_schlick_ggx;

uniform vec4 base_color : source_color = vec4(1.0);
uniform float base_roughness = .9;
uniform float base_metallic = 0.0;
uniform float normal_strength = 0.0;
uniform sampler2D albedo_map : source_color, filter_linear_mipmap_anisotropic, repeat_enable, hint_default_white;
uniform sampler2D normal_map : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D roughness_map : filter_linear_mipmap_anisotropic, repeat_enable, hint_default_white;
uniform sampler2D wet_map : filter_linear, repeat_enable, hint_default_black;
#include "res://shaders/weather_clouds.gdshaderinc"
uniform float weather_ready = 0.0;
varying vec3 world_position;

void vertex() {
    world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
    vec3 wn = normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
    vec3 weights = pow(abs(wn), vec3(4.0));
    weights /= max(dot(weights, vec3(1.0)), .00001);
    vec3 p = world_position * 2.0;
    vec3 detail = texture(albedo_map,p.zy).rgb * weights.x
                + texture(albedo_map,p.xz).rgb * weights.y
                + texture(albedo_map,p.xy).rgb * weights.z;
    float rough = texture(roughness_map,p.zy).r * weights.x
                + texture(roughness_map,p.xz).r * weights.y
                + texture(roughness_map,p.xy).r * weights.z;
    float wet = texture(wet_map,world_position.xz/weather_extent).r * weather_ready;
    ALBEDO = base_color.rgb * detail * pow(COLOR.rgb,vec3(2.2)) * (1.0-.24*wet) * cloud_shadow(world_position);
    ROUGHNESS = mix(clamp(base_roughness*rough,.04,1.0),.24,wet*.85);
    METALLIC = base_metallic;
    SPECULAR = mix(.35,.65,wet);
    if (normal_strength > .0) {
        vec3 nx=texture(normal_map,p.zy).xyz*2.0-1.0;
        vec3 ny=texture(normal_map,p.xz).xyz*2.0-1.0;
        vec3 nz=texture(normal_map,p.xy).xyz*2.0-1.0;
        vec3 perturb=vec3(0.0,nx.y,nx.x)*weights.x
                    +vec3(ny.x,0.0,ny.y)*weights.y
                    +vec3(nz.x,nz.y,0.0)*weights.z;
        NORMAL=normalize((VIEW_MATRIX*vec4(normalize(wn+perturb*normal_strength),0.0)).xyz);
    }
}
