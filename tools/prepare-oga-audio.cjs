// Selected CC0 OpenGameArt additions. Source archives stay outside Unity Assets.
// node tools/prepare-oga-audio.cjs <se-oga-audio download directory> <ffmpeg.exe>
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const [input, ffmpeg] = process.argv.slice(2);
if (!input || !ffmpeg) throw new Error('Specify the downloaded OGA directory and ffmpeg executable.');
const out = path.resolve('unity/Assets/ShatteredEmpires/Runtime/Resources/Audio/Recorded');
const edits = [];
function edit(name, source, filter, seconds, stereo = false) {
  const filename = path.join(out, name + '.ogg');
  const original = path.isAbsolute(source) ? source : path.join(input, source);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', original];
  if (seconds) args.push('-t', String(seconds));
  const processing = filter + ',alimiter=limit=0.84:level=disabled';
  args.push('-vn', '-af', processing, '-ac', stereo ? '2' : '1', '-ar', '44100', '-c:a', 'libvorbis', '-q:a', stereo ? '5' : '6', filename);
  cp.execFileSync(ffmpeg, args, { stdio: 'pipe' });
  edits.push({ file: name + '.ogg', source: path.isAbsolute(source) ? path.relative(process.cwd(), source).split(path.sep).join('/') : source, processing, seconds, stereo,
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex') });
  if (!fs.existsSync(filename + '.meta')) {
    const meta = fs.readFileSync(path.join(out, 'music_combat.ogg.meta'), 'utf8')
      .replace(/guid: \w+/, 'guid: ' + crypto.createHash('md5').update('SE/OGA/' + name).digest('hex'))
      .replace('loadType: 2', 'loadType: ' + (stereo ? '2' : '0'))
      .replace('forceToMono: 0', 'forceToMono: ' + (stereo ? '0' : '1'))
      .replace(/[ \t]+$/gm, '');
    fs.writeFileSync(filename + '.meta', meta);
  }
}
const onset = 'silenceremove=start_periods=1:start_duration=0.001:start_threshold=-45dB:start_silence=0.003';
edit('cannon_02', 'bangs/cannon_02.ogg', onset + ',highpass=f=38,lowpass=f=12500,volume=0.85,afade=t=out:st=2.8:d=0.5', 3.3);
edit('cannon_03', 'bangs/cannon_04.ogg', onset + ',highpass=f=40,volume=0.8,afade=t=out:st=2.5:d=0.5', 3);
edit('blast_03', 'bangs/fw_04.ogg', onset + ',highpass=f=30,lowpass=f=8500,volume=0.75,afade=t=out:st=3.4:d=0.6', 4);
edit('blast_04', 'bangs/bang_04.ogg', onset + ',highpass=f=45,volume=0.8,afade=t=out:st=2.8:d=0.4', 3.2);
edit('flak_01', 'bangs/shot_02.ogg', onset + ',highpass=f=130,lowpass=f=10500,volume=0.7,afade=t=out:st=0.8:d=0.2', 1);
edit('pickup_01', 'residue/residue-sfx/ammopickup.ogg', 'highpass=f=300,lowpass=f=6500,volume=0.28,afade=t=out:st=0.22:d=0.10', .32);
edit('energy_01', 'residue/residue-sfx/healthboost.ogg', 'highpass=f=350,lowpass=f=4500,volume=0.22,afade=t=out:st=0.30:d=0.12', .42);
// A 56-second authored excerpt with a clean end, separate from the adaptive match score.
edit('music_intro', 'trailer.mp3', 'atrim=start=28:duration=64,asetpts=PTS-STARTPTS,highpass=f=38,volume=0.72,afade=t=in:d=1.8,afade=t=out:st=60:d=4', 64, true);
edit('music_menu', 'menu-score.mp3', 'highpass=f=38,volume=0.62,afade=t=in:d=1.5,afade=t=out:st=66:d=3.6', 69.6, true);
edit('siren_01', 'siren.ogg', 'atrim=start=0:duration=24,asetpts=PTS-STARTPTS,highpass=f=180,lowpass=f=5500,volume=0.70,afade=t=in:d=0.8,afade=t=out:st=21:d=3', 24);
edit('mechanical_blast', 'mechanical.wav', onset + ',highpass=f=75,volume=0.68,afade=t=out:st=2.3:d=0.6', 2.9);
edit('distant_blast', 'distant-blast.wav', 'highpass=f=28,lowpass=f=1500,volume=0.85,afade=t=out:st=4:d=0.8', 4.8);
edit('amb_construction', 'environment/sfx100v2_loop_construction_site.ogg', 'highpass=f=120,lowpass=f=8000,volume=0.55', 0);
edit('amb_city', 'environment/sfx100v2_loop_highway.ogg', 'highpass=f=110,lowpass=f=4200,volume=0.42', 0);
edit('amb_river_close', 'environment/sfx100v2_loop_water_02.ogg', 'highpass=f=80,lowpass=f=14000,volume=0.52', 0);
edit('tracks_detail', 'environment/sfx100v2_loop_machine_03.ogg', 'highpass=f=250,lowpass=f=4700,volume=0.28', 0);
edit('amb_fire', 'fire.wav', 'atrim=start=3:duration=20,asetpts=PTS-STARTPTS,highpass=f=100,lowpass=f=12000,volume=0.45,afade=t=in:d=0.4,afade=t=out:st=19.5:d=0.5', 20);
for (let n = 1; n <= 2; n++) {
  edit('mg_burst_0' + n, path.join(out, 'mg_0' + n + '.ogg'),
    'asplit=3[a][b][c];[b]adelay=80:all=1[b1];[c]adelay=160:all=1[c1];[a][b1][c1]amix=inputs=3:normalize=0,highpass=f=90,lowpass=f=14000,volume=0.72,afade=t=out:st=0.5:d=0.12', .62);
}
fs.writeFileSync(path.join(out, 'oga-edits.json'), JSON.stringify(edits, null, 2) + '\n');
console.log('Prepared ' + edits.length + ' selected OpenGameArt audio assets.');
