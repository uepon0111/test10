'use strict';
/* FX definitions: all 50 fx_*.json files convert, tile frames are integral
 * and in range, and every HIT_MAP / LANE_MAP entry resolves to a file. */
const { loadJs, check, summary, ROOT, fs, path } = require('./helpers');

const Fx = loadJs('js/fx.js').ProsekaFx;
const conv = Fx._convertEmitter;
const fxDir = path.join(ROOT, 'assets', 'effects');

let converted = 0;
for (const variant of ['0', '1']) {
  const files = fs.readdirSync(path.join(fxDir, variant)).filter(f => f.endsWith('.json')).sort();
  check('variant ' + variant + ' has 25 fx files', files.length === 25, String(files.length));
  for (const f of files) {
    const json = JSON.parse(fs.readFileSync(path.join(fxDir, variant, f), 'utf8'));
    let def;
    try { def = conv(json, 0); } catch (e) { check('convert ' + variant + '/' + f, false, e.message); continue; }
    converted++;
    const t = def.tiles;
    check('tile frame integral+in range ' + variant + '/' + f,
      Number.isInteger(t.frame) && t.frame >= 0 && t.frame < t.tilesX * t.tilesY,
      'frame=' + t.frame + ' tiles=' + t.tilesX + 'x' + t.tilesY);
    check('def has name ' + variant + '/' + f, typeof def.name === 'string' && def.name.length > 0);
    // children recurse without crashing
    const walk = d => { d.children.forEach(c => { walk(c); }); };
    try { walk(def); check('children walk ' + variant + '/' + f, true); }
    catch (e) { check('children walk ' + variant + '/' + f, false, e.message); }
  }
}
check('50 fx files converted', converted === 50, String(converted));

// every mapped name resolves to a file in both variants
const allNames = new Set();
Object.values(Fx.HIT_MAP).forEach(arr => arr.forEach(n => allNames.add(n)));
Object.values(Fx.LANE_MAP).forEach(n => allNames.add(n));
let missing = [];
for (const n of allNames) {
  for (const v of ['0', '1']) {
    if (!fs.existsSync(path.join(fxDir, v, n + '.json'))) missing.push(v + '/' + n);
  }
}
check('all HIT_MAP/LANE_MAP names exist in both variants (' + allNames.size + ' defs)', missing.length === 0, missing.join(','));

// lane beams are stretched billboards (renderer mode 2, tall startSize)
{
  const lane = conv(JSON.parse(fs.readFileSync(path.join(fxDir, '0', 'fx_lane_default.json'), 'utf8')), 0);
  check('lane flash is renderer mode 2', lane.rendererMode === 2, 'mode=' + lane.rendererMode);
  check('lane flash is tall (startSizeY >> startSizeX)',
    (lane.startSizeY.constant || 0) > (lane.startSizeX ? lane.startSizeX.constant || 0 : 0) * 5,
    'y=' + (lane.startSizeY && lane.startSizeY.constant) + ' x=' + (lane.startSizeX && lane.startSizeX.constant));
}

process.exitCode = summary('test_fx') ? 1 : 0;
