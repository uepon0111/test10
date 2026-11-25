'use strict';
/* Atlas JSON: expected sprite names exist, rects are inside the sheet and
 * do not overlap. Sheet is 1644x1472 for both skins. */
const { check, summary, ROOT, fs, path } = require('./helpers');

const W = 1644, H = 1472;
const EXPECTED = [
  'body_tap_head', 'body_crit_head', 'body_crit_small',
  'body_flick_head', 'body_flick_small', 'body_long_head', 'body_long_small',
  'gem_long_l', 'gem_long_s', 'gem_crit_l', 'gem_crit_s', 'gem_flick_s'
];
for (const skin of ['01', '02']) {
  const atlas = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'notes_' + skin + '.json'), 'utf8'));
  const names = Object.keys(atlas.sprites || atlas);
  const spr = atlas.sprites || atlas;
  check('skin ' + skin + ' has 36 sprites', names.length === 36, String(names.length));
  for (const n of EXPECTED) check('skin ' + skin + ' has ' + n, !!spr[n]);
  let ok = true, bad = '';
  const rects = [];
  for (const n of names) {
    const r = spr[n];
    if (!r || r.x == null || r.y == null || r.w == null || r.h == null) { ok = false; bad = n + ' missing rect'; break; }
    if (r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H) { ok = false; bad = n + ' out of bounds'; break; }
    rects.push([r.x, r.y, r.x + r.w, r.y + r.h, n]);
  }
  check('skin ' + skin + ' rects in bounds', ok, bad);
  let overlap = null;
  for (let i = 0; i < rects.length && !overlap; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) { overlap = a[4] + ' x ' + b[4]; break; }
    }
  }
  check('skin ' + skin + ' rects do not overlap', !overlap, overlap || '');
  // chevron arrows: 24 (orientation x color x 6 widths)
  const chev = names.filter(n => n.indexOf('flick_') === 0);
  check('skin ' + skin + ' has 24 chevrons', chev.length === 24, String(chev.length));
  const png = fs.readFileSync(path.join(ROOT, 'assets', 'notes_' + skin + '.png'));
  check('skin ' + skin + ' png present', png.length > 500000, png.length + ' bytes');
}
for (const f of ['guide_01.png', 'guide_02.png', 'long_band_01.png', 'long_band_02.png',
  'effect.png', 'stage.png', 'bg_overlay.png']) {
  const p = path.join(ROOT, 'assets', f);
  check('asset present: ' + f, fs.existsSync(p) && fs.statSync(p).size > 100);
}

process.exitCode = summary('test_atlas') ? 1 : 0;
