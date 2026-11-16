// Converts the owner's Unity Asset Store downloads into the game's runtime formats.
//
//   node tools/ingest-workshop-assets.cjs <ffmpeg.exe> [asset-store-cache] [scratch-dir]
//
// asset-store-cache defaults to %APPDATA%/Unity/Asset Store-5.x. Every .unitypackage is a tar.gz of
// <guid>/{pathname,asset}; only the files selected below are extracted and converted:
//   audio    -> Vorbis .ogg (mono for positional one-shots, stereo for music and 2D beds)
//   textures -> .jpg/.png at runtime resolution (no 4K/8K sources ship)
// The output folder unity/Assets/ShatteredEmpires/Runtime/Resources/Workshop is git-ignored: the
// Asset Store EULA allows these assets inside the built game, not redistribution in this public
// source repository. Credits and the selection itself are versioned (docs/WORKSHOP_ASSETS.md,
// this file). Re-run after a fresh clone to restore the full presentation; the game falls back to
// its committed assets when the folder is absent.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');

const ffmpeg = process.argv[2];
if (!ffmpeg) throw Error('Pass the ffmpeg executable.');
const cache = process.argv[3] || path.join(process.env.APPDATA || '', 'Unity', 'Asset Store-5.x');
const scratch = process.argv[4] || fs.mkdtempSync(path.join(os.tmpdir(), 'se-workshop-'));
const out = path.resolve(__dirname, '..', 'unity/Assets/ShatteredEmpires/Runtime/Resources/Workshop');

// package file name (without extension) -> pathname suffix -> [output, kind, options]
// kinds: sfx (mono one-shot), loop (stereo bed), music (stereo), tex (jpg colour), lin (jpg linear data),
//        alpha (png with alpha), sky (jpg panorama)
const S = (src, dst, kind, o = {}) => ({ src, dst, kind, ...o });
const selection = {
  'Free Firearm': [],
  'Post Apocalypse Guns Demo': [
    S('AssaultRifles/AutoGun_3p_01.wav', 'Audio/rifle_3p_01', 'sfx', { trim: 1.1 }),
    S('AssaultRifles/AutoGun_3p_02.wav', 'Audio/rifle_3p_02', 'sfx', { trim: 1.1 }),
    S('AssaultRifles/AutoGun_far_01.wav', 'Audio/rifle_far_01', 'sfx', { trim: 2.2 }),
    S('AssaultRifles/AutoGun_far_02.wav', 'Audio/rifle_far_02', 'sfx', { trim: 2.2 }),
    S('SniperRifles/AntiMaterialRifle_3p_01.wav', 'Audio/heavy_rifle_01', 'sfx', { trim: 2.0 }),
    S('SniperRifles/AntiMaterialRifle_3p_02.wav', 'Audio/heavy_rifle_02', 'sfx', { trim: 2.0 }),
    S('SniperRifles/AntiMaterialRifle_far_01.wav', 'Audio/heavy_far_01', 'sfx', { trim: 3.0 }),
    S('SniperRifles/AntiMaterialRifle_far_02.wav', 'Audio/heavy_far_02', 'sfx', { trim: 3.0 }),
    S('Miniguns_loop/AssaultCanon_3p.wav', 'Audio/autocannon_burst', 'sfx', { trim: 1.6 }),
    S('Miniguns_loop/AssaultCanon_3p_tail.wav', 'Audio/autocannon_tail', 'sfx', { trim: 2.5 }),
    S('Shotguns/JackHammer_far_01.wav', 'Audio/shotgun_far_01', 'sfx', { trim: 2.0 }),
  ],
  'Nature Sound FX': [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(i => [1, 3, 5, 7, 9].includes(i)).map((i, k) =>
      S(`__Gift__/Weapons SFX/Klashnikov AK-47/Klashnikov (${i}).wav`, `Audio/ak_0${k + 1}`, 'sfx', { trim: 1.0 })),
    S('__Gift__/Weapons SFX/Klashnikov AK-47/Gun shell.wav', 'Audio/shell_03', 'sfx', { trim: 1.2 }),
    ...[1, 3, 5, 7].map((i, k) => S(`Lighting/Lighting (${i}).wav`, `Audio/thunder_1${k}`, 'sfx', { trim: 9 })),
    ...[1, 3, 5].map((i, k) => S(`Avalanche/Avalanche (${i}).wav`, `Audio/rumble_0${k + 1}`, 'sfx', { trim: 7 })),
    ...[1, 4].map((i, k) => S(`Volcano/Volcano (${i}).wav`, `Audio/quake_0${k + 1}`, 'sfx', { trim: 8 })),
    ...[1, 4, 7].map((i, k) => S(`Fire/Flame (${i}).wav`, `Audio/flame_0${k + 1}`, 'sfx', { trim: 3 })),
    S('Volcano/Volcano (8) Loop.wav', 'Audio/amb_dread', 'loop', { trim: 40 }),
    S('Wind/Wind (1) Loop.wav', 'Audio/amb_wind_high', 'loop', { trim: 45 }),
    S('Wind/Wind (4) Loop.wav', 'Audio/amb_wind_storm', 'loop', { trim: 45 }),
    S('Rain/Rain (2) Loop.wav', 'Audio/amb_rain_heavy', 'loop', { trim: 45 }),
    S('Fire/Fire (2) Loop.wav', 'Audio/amb_fire_large', 'loop', { trim: 30, mono: true }),
    S('Water/Water (6) Loop.wav', 'Audio/amb_stream', 'loop', { trim: 30, mono: true }),
    S('Beach/Beach (8) Loop.wav', 'Audio/amb_coast', 'loop', { trim: 45, mono: true }),
    S('Jungle/Jungle (2) Loop.wav', 'Audio/amb_wildlife', 'loop', { trim: 45 }),
  ],
  'Grenade Sound FX': [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => S(`Grenade/Grenade${i}.wav`, `Audio/explosion_${String(i).padStart(2, '0')}`, 'sfx', { trim: 6 })),
    ...['Concrete', 'Dirt', 'Metal', 'Wood', 'Glass', 'Grass', 'Stones', 'Sand'].map(m =>
      S(`Different sounds/Impact on ${m}.wav`, `Audio/impact_${m.toLowerCase()}`, 'sfx', { trim: 2 })),
    ...[1, 4, 7].map((i, k) => S(`Different sounds/Throw${i}.wav`, `Audio/throw_0${k + 1}`, 'sfx', { trim: 1.5 })),
  ],
  'Weapons of Choice - FREE': [
    ...[1, 2, 3, 4, 5].map(i => S(`GUN/Pistol_01_Fire_0${i}_SFX.wav`, `Audio/pistol_0${i + 1}`, 'sfx', { trim: 1.2 })),
    S('GUN/Pistol_01_Street_Tail_SFX.wav', 'Audio/tail_street', 'sfx', { trim: 3.5 }),
    S('GUN/Pistol_01_Mountain_Tail_SFX.wav', 'Audio/tail_valley', 'sfx', { trim: 5 }),
    S('BULLETS/Ricochets/Ricochet_01_SFX.wav', 'Audio/ricochet_01', 'sfx', { trim: 1.5 }),
    S('BULLETS/Ricochets/Ricochet_02_SFX.wav', 'Audio/ricochet_02', 'sfx', { trim: 1.5 }),
    S('BULLETS/Shell/Shell_Short_01_SFX.wav', 'Audio/shell_01', 'sfx', { trim: 1.2 }),
    S('BULLETS/Shell/Shell_Short_02_SFX.wav', 'Audio/shell_02', 'sfx', { trim: 1.2 }),
    S('GUN/Handling_Gun_01_Reload_Sq_SFX.wav', 'Audio/reload_01', 'sfx', { trim: 2.5 }),
  ],
  'Free SFX Package': [
    S('Footsteps/Footstep_Gravel_1.wav', 'Audio/step_01', 'sfx'),
    S('Footsteps/Footstep_Gravel_3.wav', 'Audio/step_02', 'sfx'),
    S('Footsteps/Footstep_Gravel_4.wav', 'Audio/step_03', 'sfx'),
    S('Exertions/Mike_Death_15.wav', 'Audio/casualty_01', 'sfx'),
    S('Exertions/Ed_Attack_1.wav', 'Audio/shout_01', 'sfx'),
    S('UI/Clicks_13.wav', 'Audio/ui_click', 'sfx', { gain: -6 }),
    S('UI2/HitsAccept2.wav', 'Audio/ui_confirm', 'sfx', { gain: -6 }),
    S('UI2/DistClickBlocked1.wav', 'Audio/ui_denied', 'sfx', { gain: -6 }),
    S('UI2/BellishAccept6.wav', 'Audio/ui_notify', 'sfx', { gain: -8 }),
    S('UI2/GlassHitScroll6.wav', 'Audio/ui_hover', 'sfx', { gain: -14 }),
  ],
  'Dynamic Music': [
    S('Battlefield/Battlefield Full Track.wav', 'Audio/music_battlefield', 'music'),
    S('Incursion/Parts/Incursion Part 1 Loop.wav', 'Audio/music_incursion', 'music'),
    S('Tension/Parts/Tension Part 1 Loop.wav', 'Audio/music_tension', 'music'),
    S('Tension/Layers/Tension High Range Loop.wav', 'Audio/music_tension_high', 'music'),
    S('Tibet/Parts/Tibet Part 4 Loop.wav', 'Audio/music_highlands', 'music'),
    S('Wasteland/Parts/Wasteland Menu Loop.wav', 'Audio/music_wasteland_menu', 'music'),
    S('Wasteland/Layers/Wasteland Bass Layer Loop.wav', 'Audio/music_wasteland_bass', 'music'),
  ],
  'Fantasy Battle Music Free Pack': [
    S('Battle Theme 2 The Battle Begins.ogg', 'Audio/music_battle_begins', 'music'),
    S('Battle Theme 4 Boss Battle.ogg', 'Audio/music_last_stand', 'music'),
    S('Music Update 1.1/At the Gates.ogg', 'Audio/music_at_the_gates', 'music'),
    S('Music Update 1.1/Blood and Steel Loop.ogg', 'Audio/music_blood_steel', 'music'),
    S('Loop 1 Tension.ogg', 'Audio/music_dread', 'music'),
    S('Bonus Theme 3 Evil Alchemy.ogg', 'Audio/music_ominous', 'music'),
  ],
  // Overrides keep the committed texture's name; each photo is scaled to that texture's mean
  // luminance so the tuned shaders keep their light balance and only the detail changes.
  'Outdoor Ground Textures': [
    S('ground_vol1/ground12/ground12_Diffuse.tga', 'Textures/GroundGrass', 'tex', { size: 1024, matchLuma: 'Textures/GroundGrass.jpg' }),
    S('ground_vol1/ground12/ground12_Normal.tga', 'Textures/GroundGrassNormal', 'lin', { size: 1024 }),
    S('ground_vol1/ground9/ground9_Diffuse.tga', 'Textures/GroundEarth', 'tex', { size: 1024, matchLuma: 'Textures/GroundEarth.jpg' }),
    S('ground_vol1/ground9/ground9_Normal.tga', 'Textures/GroundEarthNormal', 'lin', { size: 1024 }),
    S('ground_vol1/ground7/ground7_Diffuse.tga', 'Source~/Gravel_d', 'tex', { size: 1024 }),
  ],
  'Free architectural textures': [
    S('Textures/plaster_02_dif_white.tga', 'Source~/Plaster_d', 'tex', { size: 1024 }),
    S('Textures/bricks_03_dif_old_red.tga', 'Source~/Brick_d', 'tex', { size: 1024 }),
  ],
  'Yughues Free Metal Materials': [
    S('Textures/T_YFMeM_18_d.tga', 'Source~/SheetMetal_d', 'tex', { size: 1024 }),
    S('Textures/T_YFMeM_37_d.tga', 'Textures/UnitArmor', 'tex', { size: 1024, matchLuma: 'Textures/UnitArmor.jpg' }),
    S('Textures/T_YFMeM_37_s.tga', 'Textures/UnitArmorRoughness', 'lin', { size: 1024, negate: true, matchLuma: 'Textures/UnitArmorRoughness.jpg' }),
  ],
  '8K Skybox Pack Free': [
    ...[['sky-6', 'SkyDusk'], ['sky-2', 'SkyFirestorm'], ['sky-5', 'SkyAshfall'], ['sky-11', 'SkyOvercast'],
        ['sky-1', 'SkyCumulus'], ['sky-10', 'SkyNight'], ['sky-8', 'SkyDawn']].map(([id, name]) =>
      S(`Skyboxes/Texture/${id}.png`, `Sky/${name}`, 'sky', { width: 4096 })),
  ],
  'Blood splatter decal package': [
    ...[1, 2, 3, 4, 5, 6, 7].map(i => S(`blood/blood${i}.tif`, `Textures/Blood${i}`, 'alpha', { size: 256 })),
  ],
  'Grass Flowers Pack Free': [
    S('Textures/GrassFlowers/grass01.tga', 'Textures/GrassCard01', 'alpha', { size: 512 }),
    S('Textures/GrassFlowers/grass02.tga', 'Textures/GrassCard02', 'alpha', { size: 512 }),
    S('Textures/GrassFlowers/grassFlower03.tga', 'Textures/FlowerCard03', 'alpha', { size: 512 }),
    S('Textures/GrassFlowers/grassFlower07.tga', 'Textures/FlowerCard07', 'alpha', { size: 512 }),
  ],
};

const resources = path.resolve(out, '..');

/** Mean pixel (area-averaged to 1x1) of an image or a crop of it, as [r,g,b] 0-255. */
function meanRGB(file, crop) {
  const vf = (crop ? `crop=${crop},` : '') + 'scale=1:1:flags=area,format=rgb24';
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', vf, '-f', 'rawvideo', '-']);
  return [raw[0], raw[1], raw[2]];
}
const gain = k => { const v = "'clip(val*" + k.toFixed(4) + ",0,255)'"; return 'lutrgb=r=' + v + ':g=' + v + ':b=' + v; };
const luma = (file, crop) => { const [r, g, b] = meanRGB(file, crop); return r * .25 + g * .60 + b * .15; };

// Atlas quadrants in image order (top-left, top-right, bottom-left, bottom-right), matching the
// shaders' layer order 0..3 (Unity samples v upward, so the image's top half is layers 0-1).
const QUADRANT = ['0:0', 'iw/2:0', '0:ih/2', 'iw/2:ih/2'];

/**
 * Rebuilds a 2x2 atlas. Each entry is a replacement image (luminance-matched to the quadrant it
 * replaces, so the shader's per-quadrant averages stay valid) or null to keep the original quadrant.
 */
function atlas(reference, replacements, output, size) {
  const half = size / 2, inputs = [], chains = [];
  replacements.forEach((file, q) => {
    const crop = `iw/2:ih/2:${QUADRANT[q]}`;
    if (!file || !fs.existsSync(file)) {
      inputs.push('-i', reference);
      chains.push(`[${q}]crop=${crop},scale=${half}:${half}:flags=lanczos,format=rgb24[q${q}]`);
      return;
    }
    const k = luma(reference, crop) / Math.max(1, luma(file));
    inputs.push('-i', file);
    chains.push(`[${q}]scale=${half}:${half}:flags=lanczos,${gain(k)},format=rgb24[q${q}]`);
  });
  chains.push(`[q0][q1][q2][q3]xstack=inputs=4:layout=0_0|${half}_0|0_${half}|${half}_${half}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', chains.join(';'), '-q:v', '2', output]);
}

function packages() {
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.unitypackage')) found.push(p);
    }
  })(cache);
  return found;
}

function extract(pkg) {
  const dir = path.join(scratch, path.basename(pkg, '.unitypackage').replace(/\W+/g, '_'));
  if (!fs.existsSync(path.join(dir, '.done'))) {
    fs.mkdirSync(dir, { recursive: true });
    // Windows bsdtar understands drive letters; GNU tar (Git Bash) would treat "C:" as a remote host.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    try {
      execFileSync(tar, ['-xzf', pkg, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
      fs.writeFileSync(path.join(dir, '.done'), '');
    } catch {
      // An incomplete download still yields its leading entries; use them and retry next run.
      console.warn(`  ${path.basename(pkg)} is incomplete (still downloading?); using the files present`);
    }
  }
  const map = new Map();
  for (const guid of fs.readdirSync(dir)) {
    const pn = path.join(dir, guid, 'pathname'), asset = path.join(dir, guid, 'asset');
    if (fs.existsSync(pn) && fs.existsSync(asset)) map.set(fs.readFileSync(pn, 'utf8').split('\n')[0].trim(), asset);
  }
  return map;
}

function convert(input, sel) {
  const target = path.join(out, sel.dst);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Package entries are named "asset"; ffmpeg picks image decoders (TGA, TIFF) by extension.
  const named = path.join(scratch, 'convert-input' + path.extname(sel.src).toLowerCase());
  fs.rmSync(named, { force: true });
  try { fs.linkSync(input, named); } catch { fs.copyFileSync(input, named); }
  const args = ['-v', 'error', '-y', '-i', named];
  let file;
  switch (sel.kind) {
    case 'sfx': case 'loop': case 'music': {
      const mono = sel.kind === 'sfx' || sel.mono;
      const filters = [];
      if (sel.trim) filters.push(`atrim=0:${sel.trim}`, `afade=t=out:st=${Math.max(0, sel.trim - Math.min(.6, sel.trim * .25))}:d=${Math.min(.6, sel.trim * .25)}`);
      if (sel.kind === 'sfx') filters.push('highpass=f=30');
      if (sel.gain) filters.push(`volume=${sel.gain}dB`);
      if (filters.length) args.push('-af', filters.join(','));
      args.push('-ac', mono ? '1' : '2', '-ar', '44100', '-c:a', 'libvorbis', '-q:a', sel.kind === 'music' ? '5' : '4');
      file = target + '.ogg';
      break;
    }
    case 'tex': case 'lin': {
      const filters = [`scale=${sel.size}:${sel.size}:flags=lanczos`];
      if (sel.negate) filters.push('negate');
      if (sel.matchLuma) {
        // Measure the scaled source first, then multiply so its mean luminance equals the reference's.
        const probe = path.join(scratch, 'probe.png');
        execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', named, '-vf', filters.join(','), probe]);
        const k = luma(path.join(resources, sel.matchLuma)) / Math.max(1, luma(probe));
        filters.push(gain(k));
      }
      filters.push(`format=${sel.kind === 'lin' && /_(h|s|ao)$/.test(sel.dst) ? 'gray' : 'rgb24'}`);
      args.push('-vf', filters.join(','), '-q:v', '2');
      file = target + '.jpg';
      break;
    }
    case 'alpha':
      args.push('-vf', `scale=${sel.size}:${sel.size}:flags=lanczos,format=rgba`);
      file = target + '.png';
      break;
    case 'sky':
      args.push('-vf', `scale=${sel.width}:${sel.width / 2}:flags=lanczos,format=rgb24`, '-q:v', '2');
      file = target + '.jpg';
      break;
  }
  args.push(file);
  execFileSync(ffmpeg, args, { stdio: 'inherit' });
  return file;
}

const pkgs = packages();
const report = [];
for (const [name, list] of Object.entries(selection)) {
  if (!list.length) continue;
  const pkg = pkgs.find(p => path.basename(p, '.unitypackage') === name);
  if (!pkg) { console.warn(`missing package: ${name}`); continue; }
  const files = extract(pkg);
  for (const sel of list) {
    const key = [...files.keys()].find(k => k.endsWith('/' + sel.src) || k === sel.src);
    if (!key) { console.warn(`  not found in ${name}: ${sel.src}`); continue; }
    const file = convert(files.get(key), sel);
    report.push({ package: name, publisher: path.basename(path.dirname(path.dirname(pkg))), source: key, output: path.relative(out, file).replace(/\\/g, '/') });
  }
  console.log(`${name}: ${list.length} files`);
}
// Architecture: weathered plaster walls, old red brick, corrugated roof metal; the committed asphalt stays.
const src = n => path.join(out, 'Source~', n + '.jpg');
atlas(path.join(resources, 'Textures/ArchitectureAtlas.png'), [src('Plaster_d'), src('Brick_d'), src('SheetMetal_d'), null],
  path.join(out, 'Textures/ArchitectureAtlas.jpg'), 2048);
// Terrain: only layers 2 (cliff rock, kept) and 3 (district aggregate -> photographed gravel) are sampled.
atlas(path.join(resources, 'Textures/TerrainAtlas.png'), [null, null, null, src('Gravel_d')],
  path.join(out, 'Textures/TerrainAtlas.jpg'), 2048);
report.push({ composite: 'Textures/ArchitectureAtlas.jpg', from: ['Plaster_d', 'Brick_d', 'SheetMetal_d', 'committed asphalt'] });
report.push({ composite: 'Textures/TerrainAtlas.jpg', from: ['committed', 'committed', 'committed rock', 'Gravel_d'] });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Wrote ${report.length} runtime assets to ${out}`);
