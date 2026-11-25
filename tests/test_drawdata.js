'use strict';
/* buildDrawData: precomputed draw data from a hand-built buildPlay-shaped D.
 * 120 BPM, 4/4, 8 bars -> 1 bar = 2 s. hs layer 1: speed 1 until bar 2, then 2. */
const { loadJs, check, approx, summary } = require('./helpers');

const g = loadJs('js/wasm-loader.js');
const core = g.ProsekaWasm.js; // JS kernel is enough here; kernel parity is test_kernel's job
const E = loadJs('js/engine.js').ProsekaEngine;

const D = {
  total: 8,
  lens: [[0, 4]],
  bpm: [[0, 120]],
  mhs: 1,
  til: { '1': [[0, 1], [2, 2]] },
  nodes: [
    { b: 0, x: 0, w: 1, h: null, m: ['tap', false, null], s: 'p0', a: [] },
    { b: 0, x: 40, w: 1, h: null, m: ['tap', false, null], s: 'p1', a: [] },
    { b: 1, x: 20, w: 1, h: null, m: ['tap', true, null], s: 'p2', a: [] },
    { b: 2, x: 60, w: 1, h: null, m: ['flick', false, 1], s: 'p3', a: ['a0'] },
    { b: 3, x: 20, w: 1, h: null, m: ['long', false, null], s: 'p4', a: [] },
    { b: 4, x: 40, w: 1, h: 1, m: ['tap', false, null], s: 'p5', a: [] }
  ],
  chains: [
    { p: [[3, 0, 2, null], [5, 4, 2, null]], e: [0], r: [[4, 0, 'gR', null, false]], deco: false, cr: false },
    { p: [[1, 2, 2, null], [2, 2, 2, null]], e: [0], r: [], deco: true, cr: false }
  ]
};

const dd = E.buildDrawData(core, null, D, { noSofran: false });

// notes: sec times
approx(dd.notes[0].sec, 0, 1e-6, 'note bar 0 sec');
approx(dd.notes[2].sec, 2, 1e-6, 'note bar 1 sec');
approx(dd.notes[3].sec, 4, 1e-6, 'note bar 2 sec');
approx(dd.notes[4].sec, 6, 1e-6, 'note bar 3 sec');
// hs layer: bar 4 = 8 s; q = 4 s at speed 1 + 4 s at speed 2 = 12
approx(dd.notes[5].q, 12, 1e-4, 'hs-layer note q (sofran folded in)');
approx(dd.notes[5].sec, 8, 1e-6, 'hs-layer note sec');
check('sprite ids kept for flat view', dd.notes[0].s === 'p0' && dd.notes[3].a[0] === 'a0');
// per-layer q-sorted index
const li = dd.layerIndex['__none'];
let sorted = true;
for (let i = 1; i < li.notes.length; i++) if (li.notes[i].q < li.notes[i - 1].q) sorted = false;
check('layerIndex __none q-sorted', sorted);
check('layerIndex has hs layer 1', !!dd.layerIndex['1'] && dd.layerIndex['1'].notes.length === 1);
// chord pair: the two bar-0 taps, x-sorted
check('chord pair found', dd.chordPairs.length === 1 && dd.chordPairs[0][0] === 0 && dd.chordPairs[0][1] === 1,
  JSON.stringify(dd.chordPairs));
// chains
check('chains sorted by qMin', dd.chains[0].deco === true);
const long = dd.chains.find(c => !c.deco);
check('long chain hold ticks = 15 (1/8 bar, bars 3..5)', long.holdTicks.length === 15, String(long.holdTicks.length));
approx(long.holdTicks[0].sec, 6.25, 1e-4, 'first hold tick sec (bar 3.125)');
approx(long.holdTicks[14].sec, 9.75, 1e-4, 'last hold tick sec (bar 4.875)');
check('relay kept with sprite id', long.relays.length === 1 && long.relays[0].s === 'gR' && long.relays[0].seg === 0);
check('chain _one flag', long._one === true);
check('deco chain has no hold ticks', dd.chains[0].holdTicks.length === 0);
check('chain segs precomputed', long.segs.length === 1 && long.segs[0].q0 === 6 && long.segs[0].q1 === 10,
  JSON.stringify(long.segs[0]));
// bar lines: bars 0..8 x 4 beats = 36, major every 4th
check('bar lines count', dd.barLines.length === 36, String(dd.barLines.length));
check('bar lines major flags', dd.barLines.filter(l => l.major).length === 9);
approx(dd.barLines[8].q, 4, 1e-4, 'bar 2 line q on mhs layer');
// hit events
check('hit events sorted by sec', dd.hitEvents.every((e, i) => i === 0 || e.sec >= dd.hitEvents[i - 1].sec));
check('hit kinds', dd.hitEvents.map(e => e.kind).join(',') === 'tap,tap,tap_crit,flick,long,tap',
  dd.hitEvents.map(e => e.kind).join(','));
check('flick hit flagged', dd.hitEvents.find(e => e.kind === 'flick').isFlick === true);
// duration: last chart event (chain tail bar 5 = 10 s) + 1.5
approx(dd.duration, 11.5, 1e-6, 'duration');
// noSofran: q == sec everywhere
const dd2 = E.buildDrawData(core, null, D, { noSofran: true });
check('noSofran: hs note q == sec', Math.abs(dd2.notes[5].q - 8) < 1e-6, String(dd2.notes[5].q));

process.exitCode = summary('test_drawdata') ? 1 : 0;
