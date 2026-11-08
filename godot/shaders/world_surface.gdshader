shader_type spatial;
render_mode diffuse_burley, specular_schlick_ggx;

uniform vec4 base_color : source_color = vec4(1.0);
uniform float base_roughness = .9;
uniform float base_metallic = 0.0;
uniform float normal_strength = 0.0;
uniform float texture_mix = 1.0;
// Photographic CC0 maps at a real-world scale per material; their average colour is factored out
// so the art-directed palette and per-vertex tints stay in charge of hue (consistent, readable).
uniform float texture_scale = 2.0;
uniform float texture_normalize = 0.0;
uniform float weathering = 0.0;
uniform sampler2D albedo_map : source_color, filter_linear_mipmap_anisotropic, repeat_enable, hint_default_white;
uniform sampler2D normal_map : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D roughness_map : filter_linear_mipmap_anisotropic, repeat_enable, hint_default_white;
uniform sampler2D wet_map : filter_linear, repeat_enable, hint_default_black;
#include "res://shaders/weather_clouds.gdshaderinc"
#include "res://shaders/visibility_fields.gdshaderinc"
uniform float weather_ready = 0.0;
global uniform float snow_cover;
varying vec3 world_position;
// Squads drawn as one instance per unit (large battles): each soldier in the mesh is animated
// here. UV.x = figure index + part code (.3/.5 left/right leg, .7/.9 left/right arm), UV.y = height
// above the figure's feet. INSTANCE_CUSTOM: r unit seed, g moving, b down (prone/kneel), a unused.
uniform float squad_anim = 0.0;

void vertex() {
    if (squad_anim > .5) {
        float fig = floor(UV.x); float part = fract(UV.x); float h = UV.y;
        vec4 c = INSTANCE_CUSTOM;
        float seed = c.r * 97.0 + fig * 13.17;
        float moving = c.g;
        float t = TIME;
        vec2 wander = vec2(sin(t * .37 + seed), cos(t * .29 + seed * 1.7)) * mix(.014, .006, moving);
        float lag = moving * (.02 + fract(seed * .37) * .06);
        VERTEX.x += wander.x - lag;
        VERTEX.z += wander.y + moving * sin(t * .8 + seed) * .006;
        float stride = sin(t * (8.0 + fract(seed * 1.3) * 2.0) + seed);
        if (moving > .5) {
            if (part > .2 && part < .6) VERTEX.x += stride * (part < .4 ? 1.0 : -1.0) * .014 * clamp(1.0 - h / .038, 0.0, 1.0);
            if (part > .6) VERTEX.x -= stride * (part < .8 ? 1.0 : -1.0) * .01 * clamp((h - .038) / .03, 0.0, 1.0);
            VERTEX.y += abs(stride) * .0015;
        }
        VERTEX.y *= mix(1.0, .45, c.b);
    }
    world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
    vec3 wn = normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
    vec3 weights = pow(abs(wn), vec3(4.0));
    weights /= max(dot(weights, vec3(1.0)), .00001);
    vec3 p = world_position * texture_scale;
    vec3 detail = texture(albedo_map,p.zy).rgb * weights.x
                + texture(albedo_map,p.xz).rgb * weights.y
                + texture(albedo_map,p.xy).rgb * weights.z;
    float rough = texture(roughness_map,p.zy).r * weights.x
                + texture(roughness_map,p.xz).r * weights.y
                + texture(roughness_map,p.xy).r * weights.z;
    float wet = texture(wet_map,world_position.xz/weather_extent).r * weather_ready;
    if (texture_normalize > .5) {
        vec3 average = max(textureLod(albedo_map, vec2(.5), 12.0).rgb, vec3(.04));
        float lum = dot(detail, vec3(.299,.587,.114)) / max(dot(average, vec3(.299,.587,.114)), .04);
        detail = mix(vec3(lum), detail / average, .4);
    }
    vec3 surface = base_color.rgb * mix(vec3(1.0),detail,texture_mix) * pow(COLOR.rgb,vec3(2.2));
    // weathering: grime streaks on walls, rust blooms on painted and bare metal (post-collapse wear)
    if (weathering > .0) {
        float grime = fog_noise(vec2(world_position.x*7.0+world_position.z*5.0, world_position.y*28.0), 4096.0);
        surface *= 1.0 - weathering*.16*smoothstep(.45,.9,grime)*(1.0-abs(wn.y));
        if (base_metallic > .1 || texture_normalize > 1.5) {
            float rust = fog_noise(world_position.xz*9.0+world_position.yy*4.0, 4096.0);
            surface = mix(surface, vec3(.30,.16,.09), weathering*.3*smoothstep(.62,.88,rust));
        }
    }
    ALBEDO = surface * (1.0-.24*wet) * cloud_shadow(world_position);
    // settled snow on roofs and other upward faces while it snows here (camera-local weather)
    ALBEDO=mix(ALBEDO,vec3(.86,.88,.9),snow_cover*smoothstep(.55,.9,wn.y)*.85);
    vec2 knowledge=surface_visibility(world_position.xz);
    ALBEDO=remembered_surface(ALBEDO,knowledge.y)*knowledge.x;
    EMISSION=fog_ink(world_position.xz)*(1.0-knowledge.x);
    // standing water: on level upward faces (roads, yards, flat roofs) heavy rain gathers in
    // shallow mottled puddles that read as a mirror-dark sheen; walls only darken
    float level_face = smoothstep(.93,.99,wn.y);
    float puddle = smoothstep(.55,.75,fog_noise(world_position.xz*3.1, 4096.0)) * smoothstep(.45,.85,wet) * level_face;
    ALBEDO *= 1.0 - .28*puddle;
    ROUGHNESS = mix(mix(clamp(base_roughness*rough,.04,1.0),.24,wet*.85), .05, puddle);
    METALLIC = base_metallic;
    SPECULAR = mix(.35,.65,wet)*knowledge.x;
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
