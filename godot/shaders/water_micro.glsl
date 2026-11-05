#[compute]
#version 450
// Fine, advected pressure waves. RG stores surface height/vertical velocity; B stores the wet
// boundary. Geometry comes only from the received hydrology atlas. No gameplay fluid state.
layout(local_size_x=8,local_size_y=8,local_size_z=1) in;
layout(set=0,binding=0) uniform sampler2D previous_state;
layout(rgba32f,set=0,binding=1) uniform restrict writeonly image2D next_state;
layout(set=0,binding=2) uniform sampler2D water_atlas;
layout(push_constant,std430) uniform Params {
    vec4 region; // origin x/z, world extent, grid size
    vec4 simulation; // dt, time, wind x/z
    vec4 world; // world width/height, scroll in texels x/y
    vec4 weather; // rain, reset, reserved
} params;
const float ROOT3=1.732050808;
ivec2 hex_at(vec2 p) {
    vec2 axial=vec2(p.x/ROOT3-p.y/3.0,2.0*p.y/3.0);
    vec3 rounded=round(vec3(axial.x,-axial.x-axial.y,axial.y));
    vec3 delta=abs(rounded-vec3(axial.x,-axial.x-axial.y,axial.y));
    if(delta.x>delta.y && delta.x>delta.z) rounded.x=-rounded.y-rounded.z;
    else if(delta.y>delta.z) rounded.y=-rounded.x-rounded.z;
    else rounded.z=-rounded.x-rounded.y;
    int row=int(rounded.z); int col=int(rounded.x)+(row-(row&1))/2;
    int width=int(params.world.x); col=((col%width)+width)%width;
    return ivec2(col,row);
}
vec2 center(ivec2 cell,vec2 near_point) {
    vec2 p=vec2(ROOT3*(float(cell.x)+.5*float(cell.y&1)),1.5*float(cell.y));
    float period=params.world.x*ROOT3;
    p.x+=round((near_point.x-p.x)/period)*period;
    return p;
}
vec4 data_at(ivec2 cell) {
    if(cell.y<0 || cell.y>=int(params.world.y)) return vec4(0);
    int width=int(params.world.x); cell.x=((cell.x%width)+width)%width;
    return texelFetch(water_atlas,cell,0);
}
vec2 direction(vec4 data) { vec2 d=data.rg*2.0-1.0; return length(d)>.03 ? normalize(d) : vec2(0); }
float segment_distance(vec2 p,vec2 a,vec2 b) { vec2 ab=b-a; return length(p-a-ab*clamp(dot(p-a,ab)/max(.00001,dot(ab,ab)),0.0,1.0)); }
// Distance and tangent of the same center-to-center Bezier used by RiverGeometry.
vec4 channel(vec2 p) {
    ivec2 cell=hex_at(p); vec4 own=data_at(cell);
    if(own.a>.0 && own.b<.75) return vec4(1,0,0,0);
    float best=100.0; vec2 flow=vec2(0);
    for(int source=-1;source<6;source++) {
        vec2 c=center(cell,p);
        if(source>=0) c+=vec2(cos(-float(source)*1.04719755),sin(-float(source)*1.04719755))*ROOT3;
        ivec2 source_cell=hex_at(c); vec4 data=data_at(source_cell);
        if(data.a<=0 || data.b<.75) continue;
        vec2 forward=direction(data);
        float width=.20+.07*clamp(round(data.a*80.0/8.0),1.0,4.0);
        if(length(forward)<.1) { float d=length(p-c)/(.5*width); if(d<best) {best=d;flow=vec2(0);} continue; }
        vec2 end=c+forward*ROOT3;
        vec4 next=data_at(hex_at(end));
        if(next.a<=0) end=mix(c,end,.5);
        vec2 arriving=forward; float biggest=-1.0;
        for(int d=0;d<6;d++) {
            vec2 delta=vec2(cos(-float(d)*1.04719755),sin(-float(d)*1.04719755));
            vec4 upstream=data_at(hex_at(c+delta*ROOT3));
            if(upstream.b>.75 && upstream.a>biggest && dot(direction(upstream),-delta)>.98) { arriving=-delta;biggest=upstream.a; }
        }
        vec2 leaving=next.b>.75 && length(direction(next))>.1 ? direction(next) : forward;
        vec2 arriving_end=forward; float largest_end=-1.0;
        if(next.b>.75) for(int d=0;d<6;d++) {
            vec2 delta=vec2(cos(-float(d)*1.04719755),sin(-float(d)*1.04719755));
            vec4 upstream=data_at(hex_at(end+delta*ROOT3));
            if(upstream.b>.75 && upstream.a>largest_end && dot(direction(upstream),-delta)>.98) { arriving_end=-delta;largest_end=upstream.a; }
        }
        vec2 start_tangent=arriving+forward; if(length(start_tangent)<.01) start_tangent=forward;
        vec2 end_tangent=next.b>.75?arriving_end+leaving:forward; if(length(end_tangent)<.01) end_tangent=forward;
        vec2 ca=c+normalize(start_tangent)*.58, cb=end-normalize(end_tangent)*.58;
        float next_width=next.b>.75?.20+.07*clamp(round(next.a*10.0),1.0,4.0):width;
        vec2 previous=c;
        for(int k=1;k<=10;k++) {
            float t=float(k)/10.0,u=1.0-t;
            vec2 point=c*u*u*u+ca*3.0*u*u*t+cb*3.0*u*t*t+end*t*t*t;
            float d=segment_distance(p,previous,point)/(.5*mix(width,next_width,t));
            if(d<best) { best=d;flow=normalize(point-previous)*(.08+.03*data.a*10.0); }
            previous=point;
        }
    }
    return vec4(best<1.0 ? 1.0 : 0.0,flow*max(.15,1.0-best*best),best);
}
float random(vec2 point) { return fract(sin(dot(point,vec2(127.1,311.7)))*43758.5453); }
vec4 state(vec2 cell) {
    if(any(lessThan(cell,vec2(.5))) || any(greaterThanEqual(cell,vec2(params.region.w-.5)))) return vec4(0);
    return texture(previous_state,cell/params.region.w);
}
void main() {
    ivec2 index=ivec2(gl_GlobalInvocationID.xy);
    if(any(greaterThanEqual(index,ivec2(params.region.w)))) return;
    float spacing=params.region.z/params.region.w;
    vec2 point=params.region.xy+(vec2(index)+.5)*spacing;
    vec4 water=channel(point);
    float bank=1.0-smoothstep(.7,1.3,water.w);
    if(water.x<.5) {imageStore(next_state,index,vec4(0,0,0,bank));return;}
    float bank_force=smoothstep(.4,.96,water.w);
    vec2 current=water.yz+vec2(-water.z,water.y)*sin(dot(point,vec2(7.1,5.7))+params.simulation.y*.7)*bank_force*.08;
    vec2 back=vec2(index)+.5+params.world.zw-current*params.simulation.x/spacing;
    vec4 old=params.weather.y>.5 ? vec4(0) : state(back);
    float lap=-4.0*old.r;
    vec4 a=state(back+vec2(1,0)),b=state(back-vec2(1,0)),c=state(back+vec2(0,1)),d=state(back-vec2(0,1));
    lap+=(a.b>.5?a.r:old.r)+(b.b>.5?b.r:old.r)+(c.b>.5?c.r:old.r)+(d.b>.5?d.r:old.r);
    if(params.weather.y>.5) lap=0.0;
    float wind=min(length(params.simulation.zw),2.0);
    float force=(random(floor(point*20.0)+floor(params.simulation.y*13.0))-.5)*wind*.009;
    force+=bank_force*length(water.yz)*sin(dot(point,vec2(83.1,71.7))-params.simulation.y*2.7)*.002;
    float drop=random(floor(point/spacing)+floor(params.simulation.y*120.0)*vec2(17.13,29.47));
    if(drop>1.0-params.weather.x*.00008) force-=.035;
    float velocity=(old.g+(lap*.0484/(spacing*spacing)+force)*params.simulation.x)*.989;
    float edge=min(min(float(index.x),float(index.y)),min(params.region.w-1.0-float(index.x),params.region.w-1.0-float(index.y)));
    velocity*=smoothstep(0.0,10.0,edge);
    float height=clamp(old.r+velocity*params.simulation.x,-.0015,.0015);
    imageStore(next_state,index,vec4(height,clamp(velocity,-.025,.025),1.0,bank));
}
