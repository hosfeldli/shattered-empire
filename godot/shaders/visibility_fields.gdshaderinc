// Hex-neighbor edge masks soften inward only. No filtered texel can reveal an unknown cell.
uniform sampler2D visibility_field : filter_nearest, repeat_disable, hint_default_black;
uniform vec2 visibility_cells=vec2(128.0);
uniform float visibility_ready=0.0;
uniform float visibility_wrap=1.0;

ivec2 presentation_cell(vec2 position) {
    float x=.57735026919*position.x-position.y/3.0, z=2.0/3.0*position.y;
    vec3 cube=vec3(x,-x-z,z), rounded=round(cube), difference=abs(rounded-cube);
    if(difference.x>difference.y && difference.x>difference.z) rounded.x=-rounded.y-rounded.z;
    else if(difference.y>difference.z) rounded.y=-rounded.x-rounded.z;
    else rounded.z=-rounded.x-rounded.y;
    int row=int(rounded.z), column=int(rounded.x)+(row-(row&1))/2;
    int width=int(visibility_cells.x);
    if(visibility_wrap>.5) column=((column%width)+width)%width;
    return ivec2(column,row);
}
vec2 presentation_local(vec2 position,ivec2 cell) {
    vec2 center=vec2(1.73205080757*(float(cell.x)+.5*float(cell.y&1)),1.5*float(cell.y));
    vec2 local=position-center;
    if(visibility_wrap>.5) { float period=visibility_cells.x*1.73205080757; local.x-=round(local.x/period)*period; }
    return local;
}
float boundary_distance(vec2 local,int missing) {
    float nearest=2.0;
    for(int direction=0;direction<6;direction++) if((missing&(1<<direction))!=0) {
        float angle=-float(direction)*1.0471975512;
        nearest=min(nearest,.86602540378-dot(local,vec2(cos(angle),sin(angle))));
    }
    return max(0.0,nearest);
}
vec2 surface_visibility(vec2 position) {
    if(visibility_ready<.5) return vec2(1.0);
    ivec2 cell=presentation_cell(position);
    if(any(lessThan(cell,ivec2(0))) || any(greaterThanEqual(cell,ivec2(visibility_cells)))) return vec2(0.0);
    vec4 state=texelFetch(visibility_field,cell,0);
    vec2 local=presentation_local(position,cell);
    float known=state.r*smoothstep(.0,.58,boundary_distance(local,int(state.b*255.0+.5)));
    float visible=state.g*smoothstep(.0,.52,boundary_distance(local,int(state.a*255.0+.5)));
    return vec2(known,visible);
}
vec3 fog_ink(vec2 position) {
    float x=position.x/(visibility_cells.x*1.73205080757)*6.283185307;
    float grain=sin(x*19.0+sin(position.y*.11))*sin(position.y*.17+x*7.0);
    return vec3(.034,.044,.046)+grain*.0015;
}
vec3 remembered_surface(vec3 base,float visible) {
    float lightness=dot(base,vec3(.299,.587,.114));
    vec3 memory=mix(vec3(lightness)*vec3(.54,.59,.57),base*.50,.24);
    return mix(memory,base,visible);
}
