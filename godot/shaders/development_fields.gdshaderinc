// Shared cultivated ground and industrial yards, without a plane or seam at shared parcel edges.
uniform sampler2D agriculture_field : filter_nearest, repeat_disable, hint_default_black;
uniform sampler2D industry_field : filter_nearest, repeat_disable, hint_default_black;
uniform float field_ready=0.0;
uniform vec2 crop_wave=vec2(43.0,11.0);
uniform float farm_preview_active=0.0;
uniform ivec2 farm_preview_cell=ivec2(-100);
uniform int farm_preview_links=0;

vec4 development_at(sampler2D field,ivec2 cell) {
    if(visibility_wrap>.5) cell.x=((cell.x%int(visibility_cells.x))+int(visibility_cells.x))%int(visibility_cells.x);
    if(any(lessThan(cell,ivec2(0))) || any(greaterThanEqual(cell,ivec2(visibility_cells)))) return vec4(0);
    return texelFetch(field,cell,0);
}
vec3 developed_ground(vec3 base,vec2 position,float bank) {
    if(field_ready<.5) return base;
    ivec2 cell=presentation_cell(position); vec2 local=presentation_local(position,cell);
    vec4 farm=development_at(agriculture_field,cell), works=development_at(industry_field,cell);
    if(farm_preview_active>.5) {
        vec2 center=vec2(1.73205080757*(float(farm_preview_cell.x)+.5*float(farm_preview_cell.y&1)),1.5*float(farm_preview_cell.y));
        vec2 relative=position-center; float period=visibility_cells.x*1.73205080757;
        if(visibility_wrap>.5) relative.x-=round(relative.x/period)*period;
        if(length(relative)<3.0) {
            if(all(equal(cell,farm_preview_cell))) farm=vec4(1.0,float(63^farm_preview_links)/255.0,.3,1.0);
            else for(int direction=0;direction<6;direction++) if((farm_preview_links&(1<<direction))!=0) {
                float angle=-float(direction)*1.0471975512;
                ivec2 neighbor=presentation_cell(center+vec2(cos(angle),sin(angle))*1.73205080757);
                if(all(equal(cell,neighbor))) farm.g=float(int(farm.g*255.0+.5)&(~(1<<((direction+3)%6))))/255.0;
            }
        }
    }
    float verge=.30+.035*sin(position.y*3.1+sin(position.x*.7));
    float crop=farm.r*smoothstep(.035,verge,boundary_distance(local,int(farm.g*255.0+.5)));
    float yard=works.r*works.a*smoothstep(.02,.25,boundary_distance(local,int(works.g*255.0+.5)));
    float variation=.5+.5*sin(position.y*.34+sin(position.x*.11));
    float rows=sin(dot(position,crop_wave)+sin(position.y*.8)*.06)*.025;
    float detail=sin(dot(position,crop_wave*2.93))*sin(position.y*63.0)*.008;
    vec3 field_color=mix(vec3(.15,.185,.078),vec3(.245,.225,.125),variation*.65)*(1.0+rows+detail);
    float farmyard=1.0-smoothstep(.16,.30,length(local-vec2(.08,.04)));
    base=mix(base,vec3(.16,.135,.095),farmyard*farm.r*.28);
    field_color=mix(vec3(.145,.125,.075),field_color,smoothstep(.35,.95,farm.a));
    base=mix(base,field_color,crop*(1.0-farmyard*.75)*.74*(1.0-bank));
    vec3 paved=vec3(.15,.155,.145)*(1.0+sin(position.y*39.0)*.015);
    return mix(base,paved,yard*.38*(1.0-bank));
}
