"""Deterministic tileable PBR swatches, stdlib only. Shared physical scale: .5 hex units/tile."""
import math
import random
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / 'godot/assets/materials'
OUT.mkdir(parents=True, exist_ok=True)
SIZE = 256


def png(path, rgb):
    def chunk(kind, data):
        return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    raw = b''.join(b'\0'+bytes(rgb[y*SIZE*3:(y+1)*SIZE*3]) for y in range(SIZE))
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',SIZE,SIZE,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw,9))+chunk(b'IEND',b''))


for number, family in enumerate(['brick','roof_tile','roof_slate','stone','timber','plaster','rock','concrete','soil','asphalt']):
    rng = random.Random(31415+number)
    heights = []
    shades = []
    for y in range(SIZE):
        for x in range(SIZE):
            grain = rng.uniform(-.04,.04)
            row = y//32
            joint = ((x+(row%2)*32)%64 < 3 or y%32 < 3)
            if family in ['brick','stone']:
                value = .25 if joint else .65+grain
            elif family.startswith('roof'):
                value = .3 if (x+(row%2)*16)%32<2 or y%32<2 else .65+grain+.08*math.sin(y%32/32*math.pi)
            elif family == 'timber':
                value = .55+.08*math.sin(x*.4+math.sin(y*math.tau/SIZE)*2)+grain
            else:
                value = .6+grain+.05*math.sin(x*math.tau/SIZE)*math.sin(y*math.tau/SIZE)
            heights.append(value)
            shades.append(.78+value*.3)
    normal, albedo, rough = [], [], []
    for y in range(SIZE):
        for x in range(SIZE):
            i=y*SIZE+x
            dx = (heights[y*SIZE+(x+1)%SIZE]-heights[y*SIZE+(x-1)%SIZE])*.6
            dy = (heights[((y+1)%SIZE)*SIZE+x]-heights[((y-1)%SIZE)*SIZE+x])*.6
            length = math.sqrt(dx*dx+dy*dy+1)
            normal.extend([int(127.5*(1-dx/length)),int(127.5*(1+dy/length)),int(127.5*(1+1/length))])
            grey = min(255,int(shades[i]*255))
            albedo.extend([grey]*3)
            rough.extend([int(210+heights[i]*35)]*3)
    for channel, pixels in [('albedo',albedo),('normal',normal),('roughness',rough)]:
        png(OUT / f'{family}_{channel}.png',pixels)
print('Generated', len(list(OUT.glob('*.png'))),'shared material maps')
