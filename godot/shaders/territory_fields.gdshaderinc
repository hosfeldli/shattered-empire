// Territory: a hazy faction-coloured band inside each realm's border with a fine edge line.
// The field holds last-known ownership the server already sent to this viewer (fog-safe), the
// faction colour (rgb) and, in alpha, bit 6 = owned and bits 0-5 = neighbours under another owner.
// Requires visibility_fields.gdshaderinc (cell lookup, edge distances, camera size).
uniform sampler2D territory_field : filter_nearest, repeat_disable, hint_default_black;
uniform float territory_ready=0.0;
uniform float territory_strength=1.0;

vec3 territory_tint(vec3 base,vec2 position) {
    if(territory_ready<.5 || territory_strength<=0.0) return base;
    ivec2 cell=presentation_cell(position);
    if(any(lessThan(cell,ivec2(0))) || any(greaterThanEqual(cell,ivec2(visibility_cells)))) return base;
    vec4 state=texelFetch(territory_field,cell,0);
    int bits=int(state.a*255.0+.5);
    if((bits&64)==0) return base;
    float d=boundary_distance(presentation_local(position,cell),bits&63);
    // Wider strokes as the camera pulls back keep borders legible at strategic scale.
    float zoom=clamp(fog_view_size/26.0,.55,4.5);
    float line_width=.028*zoom;
    float haze_width=.40*min(zoom,2.2);
    float line=1.0-smoothstep(line_width*.45,line_width,d);
    float haze=1.0-smoothstep(0.0,haze_width,d); haze*=haze;
    float wash=.07*smoothstep(28.0,110.0,fog_view_size);
    vec3 faction=pow(state.rgb,vec3(2.2));
    vec3 tinted=mix(base,base*.45+faction*.75,clamp(wash+haze*.30,0.0,1.0));
    return mix(tinted,faction*1.05+vec3(.02),line*.62*territory_strength);
}
