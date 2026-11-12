// Edits a selected, attributed set of free recordings into the Unity runtime bank.
// Supply the local download directory and an ffmpeg executable; archives stay outside Assets.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const input = path.resolve(process.argv[2] || '.scratch/action-rts/asset-downloads');
const ffmpeg = process.argv[3] || path.join(input, 'ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe');
const output = path.resolve('unity/Assets/ShatteredEmpires/Runtime/Resources/Audio/Recorded');
fs.mkdirSync(output, { recursive: true });
const only = process.argv[4];
const manifest = only ? JSON.parse(fs.readFileSync(path.join(output,'edits.json'),'utf8')).filter((e) => e.file !== only + '.ogg') : [];
function edit(name, source, filter, duration, stereo = false, gain = 1) {
 if (only && name !== only) return;
 const args = ['-hide_banner','-loglevel','error','-y','-i',path.join(input,source),'-vn'];
 if(duration) args.push('-t',String(duration));
 const processing = [filter,`volume=${gain}`,'alimiter=limit=0.89:level=disabled'].filter(Boolean).join(',').replace(/([=:])\./g,(_,separator)=>separator+'0.');
 args.push('-af',processing,'-ac',stereo?'2':'1','-ar','44100','-c:a','libvorbis','-q:a',stereo?'5':'6',path.join(output,name+'.ogg'));
 cp.execFileSync(ffmpeg,args,{stdio:'pipe'});
 manifest.push({file:name+'.ogg',source,processing,stereo});
}
const onset = 'silenceremove=start_periods=1:start_duration=0.001:start_threshold=-46dB:start_silence=0.008';
const gun = 'firearms/Prepared SFX Library/';
edit('pistol_01',gun+'1911/A_34P.wav',onset+',highpass=f=90,afade=t=out:st=.9:d=.25',1.15,false,.65);
edit('rifle_01',gun+'AR-15/D_24P.wav',onset+',highpass=f=65,afade=t=out:st=1.4:d=.3',1.7,false,.85);
edit('rifle_02',gun+'AR-15/D_32P.wav',onset+',highpass=f=65,afade=t=out:st=1.4:d=.3',1.7,false,.85);
edit('rifle_03',gun+'AK-47/C_31P.wav',onset+',highpass=f=65,afade=t=out:st=1.5:d=.3',1.8,false,.80);
edit('mg_01',gun+'Carl Gustav M45/G_24P.wav',onset+',highpass=f=70,afade=t=out:st=1.5:d=.35',1.85,false,.80);
edit('mg_02',gun+'AK-47/C_34P.wav',onset+',highpass=f=70,afade=t=out:st=1.5:d=.35',1.85,false,.80);
edit('cannon_01','cannon.ogg',onset+',highpass=f=35,afade=t=out:st=3.4:d=.5',3.9,false,.85);
edit('blast_01','explosions/explode.wav','highpass=f=30,afade=t=out:st=2.7:d=.5',3.2,false,.78);
edit('blast_02','explosions/explodemini.wav','highpass=f=45,afade=t=out:st=2.3:d=.5',2.8,false,.78);
edit('debris_01','bfh1_rock_falling_03.ogg','highpass=f=100,afade=t=out:st=1.9:d=.3',2.2,false,.9);
edit('debris_02','bfh1_rock_breaking_01.ogg','highpass=f=100,afade=t=out:st=1.4:d=.3',1.7,false,.9);
edit('metal_01','bfh1_metal_hit_01.ogg','highpass=f=90',0,false,.85);
edit('wood_01','bfh1_wood_breaking_01.ogg','highpass=f=100',0,false,.85);
edit('glass_01','bfh1_glass_breaking_02.ogg','highpass=f=120',0,false,.75);
edit('confirm_01','bfh1_metal_hit_04.ogg','highpass=f=650,lowpass=f=3800,afade=t=out:st=.13:d=.1',.23,false,.35);
edit('thunder_01','thunder.ogg','highpass=f=28,afade=t=in:d=.02,afade=t=out:st=12:d=1',13,false,.75);
// Crossfade the end back into the start, then repeat from that same join point.
function loop(name, source, start, length, stereo, gain, band = 'highpass=f=45') {
 const fade = Math.min(1.2,length*.15);
 edit(name,source,`atrim=start=${start}:duration=${length},asetpts=PTS-STARTPTS,${band},asplit[a][b];[a]atrim=start=${fade},asetpts=PTS-STARTPTS[c];[b]atrim=duration=${fade},asetpts=PTS-STARTPTS[d];[c][d]acrossfade=d=${fade}:c1=tri:c2=tri`,0,stereo,gain);
}
loop('engine_tank','engine.ogg',0,3.8,false,.75,'highpass=f=38,lowpass=f=5500');
loop('engine_truck','truck.ogg',2,12,false,.60,'highpass=f=45,lowpass=f=6500');
loop('engine_rotor','rotor.ogg',.5,5.5,false,.70,'highpass=f=40,lowpass=f=6500');
loop('engine_jet','jet.ogg',2,5,false,.55,'highpass=f=45,lowpass=f=7000');
loop('amb_wind','wind.ogg',10,32,true,.45,'highpass=f=100,lowpass=f=9000');
loop('amb_rain','rain.ogg',6,32,true,.42,'highpass=f=100,lowpass=f=10000');
loop('amb_river','river.ogg',12,32,false,.50,'highpass=f=90,lowpass=f=10000');
loop('amb_forest','forest.ogg',5,32,true,.60,'highpass=f=130');
loop('amb_industry','industry.ogg',4,16,false,.38,'highpass=f=65,lowpass=f=6000');
edit('music_calm','calm.mp3','highpass=f=35',0,true,.60);
edit('music_combat','score.wav','highpass=f=35',0,true,.60);
fs.writeFileSync(path.join(output,'edits.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Prepared '+manifest.length+' selected audio assets.');
