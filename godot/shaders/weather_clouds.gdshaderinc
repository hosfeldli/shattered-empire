// Shared density and solar projection: cloud volumes and every world surface see one sky.
uniform sampler2D cloud_tex : filter_linear, repeat_enable, hint_default_black;
uniform sampler2D cloud_prev : filter_linear, repeat_enable, hint_default_black;
uniform float cloud_blend=1.0;
uniform vec2 cloud_off=vec2(0.0);
uniform vec2 cloud_off_prev=vec2(0.0);
uniform vec2 weather_extent=vec2(221.7,192.0);
uniform vec2 cloud_drift=vec2(0.0);
uniform vec2 cloud_light_slant=vec2(.55,.55);
uniform float cloud_time=0.0;
uniform float cloud_ready=0.0;
uniform float cloud_altitude=6.0;
uniform float cloud_shadow_strength=.27;
uniform sampler2D cloud_velocity : filter_linear, repeat_enable, hint_default_black;
uniform float cloud_velocity_ready=0.0;
uniform float cloud_age=0.0;
uniform float cloud_age_prev=0.0;

float cloud_hash(vec2 p,float repeat_x) {
    p.x=mod(p.x,repeat_x);
    return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float cloud_noise(vec2 p,float repeat_x) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(cloud_hash(i,repeat_x),cloud_hash(i+vec2(1,0),repeat_x),f.x),mix(cloud_hash(i+vec2(0,1),repeat_x),cloud_hash(i+vec2(1,1),repeat_x),f.x),f.y);
}
float cloud_coverage(vec2 position) {
    vec2 uv=position/weather_extent;
    uv.y=clamp(uv.y,0.001,.999);
    vec2 velocity=texture(cloud_velocity,vec2(fract(uv.x),uv.y)).rg;
    vec2 offset=mix(cloud_off,velocity*cloud_age,cloud_velocity_ready);
    vec2 previous_offset=mix(cloud_off_prev,velocity*cloud_age_prev,cloud_velocity_ready);
    return mix(texture(cloud_prev,vec2(fract(uv.x-previous_offset.x),clamp(uv.y-previous_offset.y,.001,.999))).r,
               texture(cloud_tex,vec2(fract(uv.x-offset.x),clamp(uv.y-offset.y,.001,.999))).r,cloud_blend)*cloud_ready;
}
float cloud_density(vec2 position,float layer) {
    vec2 uv=(position-cloud_drift)/weather_extent;
    vec2 scale=vec2(32.0,max(12.0,weather_extent.y/weather_extent.x*32.0));
    vec2 p=uv*scale;
    float billow=cloud_noise(p,32.0)*.57+cloud_noise(p*2.0+vec2(0,layer*1.2),64.0)*.29+cloud_noise(p*4.0+vec2(0,cloud_time*.018),128.0)*.14;
    float coverage=cloud_coverage(position);
    float shape=smoothstep(.22,.78,coverage+(billow-.48)*.65);
    float vertical=smoothstep(0.0,.18,layer)*(1.0-smoothstep(.48+billow*.35,1.0,layer));
    return shape*vertical*smoothstep(.02,.18,coverage)*cloud_ready;
}
float cloud_shadow(vec3 position) {
    vec2 projected=position.xz+cloud_light_slant*max(0.0,cloud_altitude-position.y);
    float density=cloud_density(projected,.4);
    // Finite solar disc: a nearby second sample softens the penumbra consistently at all zooms.
    density=(density+cloud_density(projected+vec2(.45,-.32),.5))*.5;
    return 1.0-density*cloud_shadow_strength;
}
