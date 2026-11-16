// node tools/prepare-surface-materials.cjs <directory of extracted ambientCG 1K-JPG releases>
// The input directories are Ground037, Fabric061 and Metal032. Assets remain unmodified.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const input = process.argv[2];
if (!input) throw Error('Pass the extracted ambientCG material directory.');
const output = 'unity/Assets/ShatteredEmpires/Runtime/Resources/Textures';
const assets = [
  ['Ground037', 'Color', 'GroundEarth'], ['Ground037', 'NormalGL', 'GroundEarthNormal'],
  ['Fabric061', 'Color', 'UnitFabric'], ['Fabric061', 'Roughness', 'UnitFabricRoughness'],
  ['Metal032', 'Color', 'UnitArmor'], ['Metal032', 'Roughness', 'UnitArmorRoughness'],
];
const manifest = [];
for (const [id, channel, name] of assets) {
  const source = `${id}_1K-JPG_${channel}.jpg`, bytes = fs.readFileSync(path.join(input,id,source));
  fs.writeFileSync(path.join(output,name+'.jpg'),bytes);
  manifest.push({ file:name+'.jpg', asset:id, source, url:`https://ambientcg.com/view?id=${id}`,
    download:`https://ambientcg.com/get?file=${id}_1K-JPG.zip`, license:'CC0-1.0',
    processing:'Original unmodified JPEG; mipmaps and compression are applied by Unity during import.',
    sha256:crypto.createHash('sha256').update(bytes).digest('hex') });
}
fs.writeFileSync(path.join(output,'material-sources.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Prepared ${assets.length} credited material maps.`);
