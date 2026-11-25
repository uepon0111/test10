'use strict';
/* WASM vs JS kernel consistency. Serves the project over a local HTTP
 * server so ProsekaWasm.load() runs through its real fetch path. */
const http = require('http');
const { loadJs, check, approxArr, summary, ROOT, fs, path } = require('./helpers');

const MIME = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const g = loadJs('js/wasm-loader.js');
  const core = await g.ProsekaWasm.load('http://127.0.0.1:' + port + '/wasm/proseka_core.wasm');
  const js = g.ProsekaWasm.js;
  console.log('kernel under test:', core.isWasm ? 'WASM' : 'JS fallback', '(version', core.version(), ')');
  check('WASM loaded (not JS fallback)', !!core.isWasm);
  check('version() > 0', core.version() > 0);

  // pj_batch: random lane/depth inputs, game geometry constants.
  {
    const n = 500, inp = new Float32Array(n * 2), oW = new Float32Array(n * 4), oJ = new Float32Array(n * 4);
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < n * 2; i++) inp[i] = (rnd() - 0.5) * 24;
    core.pjBatch(inp, oW, n, 960, 62, 792, 126.4, 1, undefined);
    js.pjBatch(inp, oJ, n, 960, 62, 792, 126.4, 1, undefined);
    approxArr(oW, oJ, 1e-3, 'pjBatch');
    // sanity: centre lane at z=0 lands on the judgement line.
    const inp2 = new Float32Array([0, 0]), out2 = new Float32Array(4);
    core.pjBatch(inp2, out2, 1, 960, 62, 792, 126.4, 1, undefined);
    check('pj centre z=0 -> (960, 792)', Math.abs(out2[0] - 960) < 0.01 && Math.abs(out2[1] - 792) < 0.01, out2[0] + ',' + out2[1]);
  }
  // bar<->sec with a tempo map: 120 BPM bars 0-2, 180 BPM after.
  {
    // bx = cumulative beats at each BPM change, bs = seconds at each change.
    // Bar 2 = 8 beats; 120 BPM -> 2 s/bar, so the change is at 4 s.
    const total = 8;
    const cum = new Float32Array(total + 2), len = new Float32Array(total + 2);
    for (let m = 0; m < total + 2; m++) { cum[m] = m * 4; len[m] = 4; }
    const bx = new Float32Array([0, 8]), bs = new Float32Array([0, 4]), bpm = new Float32Array([120, 180]);
    const bars = new Float32Array([0, 0.5, 1, 2, 2.5, 3]);
    const oW = new Float32Array(6), oJ = new Float32Array(6);
    core.barToSecBatch(bars, oW, 6, cum, len, total, bx, bs, bpm);
    js.barToSecBatch(bars, oJ, 6, cum, len, total, bx, bs, bpm);
    approxArr(oW, oJ, 1e-4, 'barToSecBatch');
    approxArr(oW, new Float32Array([0, 1, 2, 4, 4 + 2 / 3, 4 + 4 / 3]), 1e-4, 'barToSec values (120BPM=2s/bar, 180BPM=4/3s/bar)');
    const secs = new Float32Array([0, 1, 2, 4, 5, 5.5]);
    const bW = new Float32Array(12), bJ = new Float32Array(12);
    core.secToBarBatch(secs, bW, 6, cum, len, total, bx, bs, bpm);
    js.secToBarBatch(secs, bJ, 6, cum, len, total, bx, bs, bpm);
    approxArr(bW, bJ, 1e-4, 'secToBarBatch');
    check('secToBar bar channel', Math.abs(bW[0]) < 1e-6 && Math.abs(bW[2] - 0.5) < 1e-6 && Math.abs(bW[6] - 2) < 1e-6 && Math.abs(bW[8] - 2.75) < 1e-4 && Math.abs(bW[10] - 3.125) < 1e-4,
      'bars=' + [bW[0], bW[2], bW[4], bW[6], bW[8], bW[10]].join(','));
    check('secToBar bpm channel', bW[1] === 120 && bW[7] === 180, 'bpm=' + [bW[1], bW[7]].join(','));
    // round trip bar->sec->bar
    const back = new Float32Array(12);
    core.secToBarBatch(oW, back, 6, cum, len, total, bx, bs, bpm);
    for (let i = 0; i < 6; i++) check('roundtrip bar ' + bars[i], Math.abs(back[i * 2] - bars[i]) < 1e-4, back[i * 2]);
  }
  // scroll (sofran) + speed.
  {
    const tev = new Float32Array([0, 2, 4]), vev = new Float32Array([1, 2, 0.5]), pev = new Float32Array([0, 2, 6]);
    const times = new Float32Array([0, 1, 2, 3, 4, 5]);
    const oW = new Float32Array(6), oJ = new Float32Array(6);
    core.scrollBatch(times, oW, 6, tev, vev, pev);
    js.scrollBatch(times, oJ, 6, tev, vev, pev);
    approxArr(oW, oJ, 1e-4, 'scrollBatch');
    approxArr(oW, new Float32Array([0, 1, 2, 4, 6, 6.5]), 1e-4, 'scroll values (integral of speed)');
    const sW = new Float32Array(6), sJ = new Float32Array(6);
    core.scrollSpeedBatch(times, sW, 6, tev, vev);
    js.scrollSpeedBatch(times, sJ, 6, tev, vev);
    approxArr(sW, sJ, 1e-4, 'scrollSpeedBatch');
  }
  // slide easing: closed-form solutions must match the JS reference.
  {
    const f = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
    const ein = new Float32Array([0, 1, 0, 1, 0]), eout = new Float32Array([0, 0, 1, 1, 0]);
    const oW = new Float32Array(5), oJ = new Float32Array(5);
    core.slideEaseBatch(f, ein, eout, oW, 5);
    js.slideEaseBatch(f, ein, eout, oJ, 5);
    approxArr(oW, oJ, 1e-5, 'slideEaseBatch');
    check('slideEase endpoints 0/1', Math.abs(oW[0]) < 1e-6 && Math.abs(oW[4] - 1) < 1e-6);
  }
  // rand_hash: f64 path must match Math.sin-based JS within 1e-6.
  {
    let worst = 0;
    for (let i = 0; i < 200; i++) for (let j = 0; j < 20; j++) {
      const d = Math.abs(core.randHash(i, j) - js.randHash(i, j));
      if (d > worst) worst = d;
    }
    check('randHash WASM vs JS (worst ' + worst.toExponential(2) + ')', worst < 1e-6);
    check('randHash in [0,1)', core.randHash(3, 7) >= 0 && core.randHash(3, 7) < 1);
  }
  // particle_step: gravity + size/alpha LUTs.
  {
    const mk = () => {
      const st = new Float32Array(2 * 12);
      st[0] = 100; st[1] = 200; st[2] = 10; st[3] = -20; st[4] = 0; st[5] = 1; st[6] = 50; st[7] = 0.8;
      st[12] = 300; st[13] = 400; st[14] = 0; st[15] = 0; st[16] = 0; st[17] = 0.5; st[18] = 40; st[19] = 1;
      return st;
    };
    const sizeLut = new Float32Array([1, 0.8, 0.5, 0.2]), alphaLut = new Float32Array([0, 0.5, 1, 0.5]);
    const sW = mk(), sJ = mk();
    const szW = new Float32Array(2), alW = new Float32Array(2), szJ = new Float32Array(2), alJ = new Float32Array(2);
    const aW = core.particleStep(sW, 2, 0.1, 9.81, sizeLut, alphaLut, szW, alW);
    const aJ = js.particleStep(sJ, 2, 0.1, 9.81, sizeLut, alphaLut, szJ, alJ);
    check('particleStep alive count', aW === 2 && aJ === 2, aW + '/' + aJ);
    approxArr(sW, sJ, 1e-3, 'particleStep state');
    approxArr(szW, szJ, 1e-4, 'particleStep size');
    approxArr(alW, alJ, 1e-4, 'particleStep alpha');
    // dead particle is skipped and stays dead
    const sD = mk(); sD[5] = 0.001;
    const n = core.particleStep(sD, 2, 0.1, 0, null, null, new Float32Array(2), new Float32Array(2));
    check('particleStep kills expired particle', n === 1, 'alive=' + n);
  }
  server.close();
  process.exitCode = summary('test_kernel') ? 1 : 0;
})().catch(e => { console.error(e); server.close(); process.exit(1); });
