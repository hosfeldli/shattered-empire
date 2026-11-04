"""Small original event sounds for the native preview. No third-party recordings."""
import math
import random
import struct
import wave
from pathlib import Path
out=Path(__file__).resolve().parents[2]/'godot/assets/audio'
out.mkdir(parents=True,exist_ok=True)
rate=22050
for name,length,frequency in [('fire',.12,210),('impact',.5,63),('kill',.8,44)]:
    rng=random.Random(name)
    previous=0
    samples=[]
    for index in range(int(length*rate)):
        time=index/rate
        envelope=math.exp(-time*7/length)*min(1,time*3000)
        noise=rng.uniform(-1,1)
        previous=previous*.8+noise*.2
        value=(noise*.5 if name=='fire' else previous*.8)+math.sin(math.tau*frequency*time)*.25
        samples.append(struct.pack('<h',int(max(-1,min(1,value*envelope))*.7*32767)))
    with wave.open(str(out/f'{name}.wav'),'wb') as stream:
        stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(rate);stream.writeframes(b''.join(samples))
