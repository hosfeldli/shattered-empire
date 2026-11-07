// Hex-neighbor edge masks soften inward only. No filtered texel can reveal an unknown cell.
uniform sampler2D visibility_field : filter_nearest, repeat_disable, hint_default_black;
uniform vec2 visibility_cells=vec2(128.0);
uniform float visibility_ready=0.0;
uniform float visibility_wrap=1.0;

global uniform float fog_view_size;
float fog_hash(vec2 p,float repeat_x) {
    p.x=mod(p.x,repeat_x);
    return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float fog_noise(vec2 p,float repeat_x) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(fog_hash(i,repeat_x),fog_hash(i+vec2(1,0),repeat_x),f.x),mix(fog_hash(i+vec2(0,1),repeat_x),fog_hash(i+vec2(1,1),repeat_x),f.x),f.y);
}
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
    float edge=boundary_distance(local,int(state.b*255.0+.5));
    // Billowing cloud fronts spill a little way into explored ground (never the other way).
    float period=visibility_cells.x*1.73205080757;
    float edge_lattice=max(4.0,round(period*1.3));
    vec2 q=position*edge_lattice/period;
    float billow=fog_noise(q+vec2(TIME*.03,0.0),edge_lattice)*.65+fog_noise(q*2.7+vec2(0.0,TIME*.05),edge_lattice*2.7)*.35;
    float known=state.r*smoothstep(.0,.42,edge-.62*billow+.10);
    float visible=state.g*smoothstep(.0,.52,boundary_distance(local,int(state.a*255.0+.5)));
    return vec2(known,visible);
}
// Unexplored land lies under a slow-moving sea of thick cumulus. The clouds are painted only
// through the same knowledge mask that hides terrain, so they cannot expose an unknown cell; they
// are self-shaded from a procedural height field (no textures) and drift with time. The camera's
// orthographic size fades fine octaves so wide views stay calm instead of shimmering.
float fog_height(vec2 position) {
    float period=visibility_cells.x*1.73205080757;
    float lattice=max(4.0,round(period*.3));         // ~3.3 world units per billow, wraps exactly
    vec2 p=position*lattice/period;
    float t=TIME;
    float detail=clamp((60.0-fog_view_size)/45.0,0.0,1.0);
    float h=fog_noise(p+vec2(t*.021,t*.006),lattice)*.52;
    h+=fog_noise(p*2.0+vec2(-t*.034,t*.017)+vec2(5.2,1.3),lattice*2.0)*.27;
    h+=fog_noise(p*4.0+vec2(t*.05,-t*.02)+vec2(1.7,9.2),lattice*4.0)*.14*(.35+.65*detail);
    h+=fog_noise(p*8.0+vec2(-t*.07,t*.04)+vec2(8.3,2.8),lattice*8.0)*.07*detail;
    // broad swells: banks of cloud with lower valleys between them
    h=mix(h,h*(.7+.6*fog_noise(p*.31+vec2(t*.008,0.0),max(1.0,round(lattice*.31)))),.6);
    return h;
}
vec3 fog_ink(vec2 position) {
    float e=.18;
    float h=fog_height(position);
    float hx=fog_height(position+vec2(e,0.0))-fog_height(position-vec2(e,0.0));
    float hz=fog_height(position+vec2(0.0,e))-fog_height(position-vec2(0.0,e));
    vec3 normal=normalize(vec3(-hx*2.6/(2.0*e),1.0,-hz*2.6/(2.0*e)));
    vec3 sun=normalize(vec3(-.55,.72,-.42));
    float lit=clamp(dot(normal,sun),0.0,1.0);
    float cavity=smoothstep(.18,.78,h);
    vec3 deep=vec3(.17,.20,.24), body=vec3(.46,.50,.54), crest=vec3(.82,.82,.80);
    vec3 color=mix(deep,body,cavity);
    color=mix(color,crest,pow(lit,1.6)*(.35+.65*cavity));
    // silver lining where puffs face the sun at their rims
    color+=vec3(.05,.045,.03)*pow(lit,6.0)*cavity;
    return color*.5;
}
vec3 remembered_surface(vec3 base,float visible) {
    float lightness=dot(base,vec3(.299,.587,.114));
    vec3 memory=mix(vec3(lightness)*vec3(.54,.59,.57),base*.50,.24);
    memory=mix(memory,vec3(.36,.40,.44),.12);   // a light cool haze over ground out of sight
    return mix(memory,base,visible);
}
