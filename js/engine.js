/* Proseka Engine (v2): the single owner of playback state.
 *
 * Boundary (spec B):
 *   - The engine owns: current time, duration, chart end, lead-in,
 *     tempo map, visual-time (scroll) tables, DrawData, audio clock,
 *     latency state. The UI only *asks* via getState() and *commands*
 *     via play/pause/seek/setSettings. The UI never computes note
 *     positions, bar numbers, or BPM itself.
 *   - DrawData is built once per chart (buildDrawData): every note's
 *     second-time, scroll position q (tempo map + hi-speed folded in),
 *     chord lines, long-band segments, hold ticks and hit events are
 *     precomputed. A frame only binary-searches the visible q window
 *     and emits quads.
 *   - Hot math (projection, bar<->sec, scroll, slide easing, particle
 *     physics) runs in the Rust/WASM core (ProsekaWasm) with the JS
 *     kernels in js/wasm-loader.js as fallback.
 *
 * Coordinate notes (same as the original Canvas2D player):
 *   JY = 480 (flat-view judgement-line y), LW = 20 (flat lane px),
 *   game view: yV = 5.74% , yJ = 73.47% of stage height,
 *   LU = 6.58% of stage width, KAP = 45*ln(1.06), ZF = 0.978,
 *   s = exp(-KAP*z), recipW = s, x = cx + sg*lp*LU*s.
 */
(function (global) {
  'use strict';

  var JY = 480, LW = 20, LEAD = 1.6;
  var KAP = 45 * Math.log(1.06), ZF = 0.978, SF = Math.exp(-KAP * ZF);
  var TT = function (v) { return Math.max(0.1, 3.1 - 0.25 * v); };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function zOf(f) { return -Math.log(SF + f * (1 - SF)) / KAP; }

  /* ------------------------------------------------------------------ */
  /* Tempo map: bar <-> seconds, built once from D.lens / D.bpm.        */
  function TempoMap(D) {
    var total = D.total;
    var len = new Float32Array(total + 2);
    var cum = new Float32Array(total + 2);
    var l = (D.lens || []).slice().sort(function (a, b) { return a[0] - b[0]; });
    var i = 0, c = 4;
    for (var b = 0; b <= total + 1; b++) {
      while (i < l.length && l[i][0] <= b) c = l[i++][1];
      len[b] = c; cum[b + 1] = cum[b] + c;
    }
    var bp = (D.bpm || []).slice().sort(function (a, b) { return a[0] - b[0]; });
    var cb = function (B) {
      var m = Math.min(Math.max(Math.floor(B + 1e-9), 0), total + 1);
      return cum[m] + (B - m) * len[m];
    };
    if (!bp.length) bp.push([0, 120]);
    else if (cb(bp[0][0]) > 1e-9) bp.unshift([0, bp[0][1]]);
    var bx = new Float32Array(bp.length), bs = new Float32Array(bp.length), bv = new Float32Array(bp.length);
    for (var j = 0; j < bp.length; j++) { bx[j] = cb(bp[j][0]); bv[j] = bp[j][1]; }
    for (var k = 1; k < bp.length; k++) bs[k] = bs[k - 1] + (bx[k] - bx[k - 1]) * 60 / bv[k - 1];
    this.total = total; this.len = len; this.cum = cum;
    this.bx = bx; this.bs = bs; this.bpm = bv;
  }
  TempoMap.prototype.barToSec = function (core, bars, out) {
    core.barToSecBatch(bars, out, bars.length, this.cum, this.len, this.total, this.bx, this.bs, this.bpm);
  };
  TempoMap.prototype.secToBar = function (core, secs, out) {
    core.secToBarBatch(secs, out, secs.length, this.cum, this.len, this.total, this.bx, this.bs, this.bpm);
  };

  /* Scroll table for one hi-speed layer: S(t) = integral of speed.
   * events: [[bar, speed]] sorted. Built from the tempo map. */
  function ScrollLayer(core, tempo, events) {
    var ev = (events || []).slice().sort(function (a, b) { return a[0] - b[0]; });
    var bars = new Float32Array(ev.length);
    for (var i = 0; i < ev.length; i++) bars[i] = ev[i][0];
    var secs = new Float32Array(ev.length);
    if (ev.length) tempo.barToSec(core, bars, secs);
    var T = secs, V = new Float32Array(ev.length), P = new Float32Array(ev.length);
    var p = 0, pt = 0, v = 1;
    for (var j = 0; j < ev.length; j++) {
      p += v * (T[j] - pt); pt = T[j]; v = ev[j][1];
      V[j] = v; P[j] = p;
    }
    this.T = T; this.V = V; this.P = P;
  }
  ScrollLayer.prototype.q = function (core, times, out) {
    core.scrollBatch(times, out, times.length, this.T, this.V, this.P);
  };
  ScrollLayer.prototype.speedAt = function (core, times, out) {
    core.scrollSpeedBatch(times, out, times.length, this.T, this.V);
  };
  ScrollLayer.prototype.qAt = function (t) {
    var T = this.T, V = this.V, P = this.P;
    var lo = 0, hi = T.length - 1, k = -1;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (T[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    return k < 0 ? t : P[k] + V[k] * (t - T[k]);
  };
  ScrollLayer.prototype.speedAtScalar = function (t) {
    var T = this.T, V = this.V;
    var lo = 0, hi = T.length - 1, k = -1;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (T[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    return k < 0 ? 1 : V[k];
  };

  /* ------------------------------------------------------------------ */
  /* DrawData: everything the frame loop needs, precomputed at load.    */
  function buildDrawData(core, S, D, settings) {
    var tempo = new TempoMap(D);
    var sfOn = !settings.noSofran;
    var layers = {};
    var getLayer = function (h) {
      if (!sfOn || h == null) return null;
      var key = String(h);
      if (!layers[key]) layers[key] = new ScrollLayer(core, tempo, (D.til || {})[key]);
      return layers[key];
    };
    var identQ = function (times, out) { out.set(times); };

    // --- notes: sec time + scroll q, per hi-speed layer, q-sorted. ---
    var nodes = D.nodes || [];
    var secs = new Float32Array(nodes.length);
    var bars = new Float32Array(nodes.length);
    for (var i = 0; i < nodes.length; i++) bars[i] = nodes[i].b;
    tempo.barToSec(core, bars, secs);
    var notes = [];
    var byLayer = {};
    for (var n = 0; n < nodes.length; n++) {
      var nd = nodes[n];
      var layer = getLayer(nd.h);
      var q = layer ? 0 : secs[n]; // filled below in bulk per layer
      notes.push({
        sec: secs[n], bar: nd.b, x: nd.x, w: nd.w, hs: nd.h == null ? null : nd.h,
        kind: nd.m ? nd.m[0] : 'tap', crit: nd.m ? !!nd.m[1] : false,
        arrow: nd.m ? nd.m[2] : null, layer: layer, q: q, _i: n,
        s: nd.s || null, a: nd.a || []
      });
    }
    // Bulk scroll conversion per layer (tempo + hi-speed folded in here).
    var layerGroups = {};
    notes.forEach(function (nt) {
      var k = nt.hs == null ? '__none' : String(nt.hs);
      (layerGroups[k] = layerGroups[k] || []).push(nt);
    });
    Object.keys(layerGroups).forEach(function (k) {
      var group = layerGroups[k];
      var ts = new Float32Array(group.length);
      var qs = new Float32Array(group.length);
      for (var i = 0; i < group.length; i++) ts[i] = group[i].sec;
      if (k === '__none' || !sfOn) identQ(ts, qs);
      else layers[k].q(core, ts, qs);
      for (var j = 0; j < group.length; j++) group[j].q = qs[j];
    });
    // Per-layer q-sorted index for the visible-window binary search.
    var layerIndex = {};
    Object.keys(layerGroups).forEach(function (k) {
      var g = layerGroups[k].slice().sort(function (a, b) { return a.q - b.q; });
      var qArr = new Float32Array(g.length);
      for (var i = 0; i < g.length; i++) qArr[i] = g[i].q;
      layerIndex[k] = { notes: g, q: qArr };
    });

    // --- chains: slide paths in scroll space. -------------------------
    var chains = [];
    (D.chains || []).forEach(function (c) {
      var pts = c.p; // [bar, lane-2, w, hs]
      var pBars = new Float32Array(pts.length);
      for (var i = 0; i < pts.length; i++) pBars[i] = pts[i][0];
      var pSecs = new Float32Array(pts.length);
      tempo.barToSec(core, pBars, pSecs);
      var pQs = new Float32Array(pts.length);
      var layer0 = getLayer(pts[0][3]);
      if (layer0 && sfOn) layer0.q(core, pSecs, pQs);
      else pQs.set(pSecs);
      // NOTE: points of one chain may use different hs ids; the original
      // player used the point's own layer per point. Recompute per point
      // when the chain mixes layers.
      var mixed = pts.some(function (p) { return p[3] !== pts[0][3]; });
      if (mixed && sfOn) {
        for (var j = 0; j < pts.length; j++) {
          var lj = getLayer(pts[j][3]);
          pQs[j] = lj ? lj.qAt(pSecs[j]) : pSecs[j];
        }
      }
      var qMin = Infinity, qMax = -Infinity;
      for (var k2 = 0; k2 < pQs.length; k2++) { qMin = Math.min(qMin, pQs[k2]); qMax = Math.max(qMax, pQs[k2]); }
      var segs = [];
      for (var s = 0; s + 1 < pts.length; s++) {
        segs.push({
          q0: pQs[s], q1: pQs[s + 1],
          l0: pts[s][1], w0: pts[s][2], l1: pts[s + 1][1], w1: pts[s + 1][2],
          ein: c.e[s] === 2, eout: c.e[s] === 5 || c.e[s] === 6
        });
      }
      var relays = (c.r || []).map(function (r) {
        var rb = new Float32Array([r[0]]), rs = new Float32Array(1);
        tempo.barToSec(core, rb, rs);
        var rl = getLayer(r[3]);
        var rq = rl && sfOn ? rl.qAt(rs[0]) : rs[0];
        // relay lane: find the segment it sits on for the lane position.
        var lane = pts[0][1] + pts[0][2] / 2;
        return { q: rq, sec: rs[0], seg: r[1], kind: r[4] ? 'crit' : 'long', lane: lane, s: r[2] || null, h: r[3] };
      });
      // Hold ticks: every 1/8 bar between head and tail (original rule).
      var holdTicks = [];
      if (!c.deco) {
        var headBar = pts[0][0], tailBar = pts[pts.length - 1][0];
        for (var hb = Math.floor((headBar + 1e-9) * 8) + 1; hb / 8 < tailBar - 1e-9; hb++) {
          var tb = new Float32Array([hb / 8]), ts2 = new Float32Array(1);
          tempo.barToSec(core, tb, ts2);
          var tl = getLayer(pts[0][3]);
          holdTicks.push({ sec: ts2[0], q: tl && sfOn ? tl.qAt(ts2[0]) : ts2[0] });
        }
      }
      chains.push({
        deco: !!c.deco, crit: !!c.cr, pts: pts, pSecs: pSecs, pQs: pQs,
        segs: segs, relays: relays, holdTicks: holdTicks,
        qMin: qMin, qMax: qMax, layer: layer0,
        e: c.e, _one: pts.every(function (p) { return p[3] === pts[0][3]; }),
        _qa: qMin, _qb: qMax
      });
    });
    chains.sort(function (a, b) { return a.qMin - b.qMin; });

    // --- chord lines: same-bar adjacent notes, precomputed pairs. -----
    var chordPairs = [];
    var byBar = new Map();
    notes.forEach(function (nt, idx) {
      if (nt.kind === 'relay' || nt.kind === 'dmg') return;
      var key = Math.round(nt.bar * 1e5);
      var a = byBar.get(key); if (!a) { a = []; byBar.set(key, a); }
      a.push(idx);
    });
    byBar.forEach(function (idxs) {
      if (idxs.length < 2) return;
      idxs.sort(function (a, b) { return notes[a].x - notes[b].x; });
      for (var i = 0; i + 1 < idxs.length; i++) chordPairs.push([idxs[i], idxs[i + 1]]);
    });

    // --- bar lines on the main (measure) layer. ------------------------
    var barLines = [];
    var mhsLayer = getLayer(D.mhs);
    var total = D.total;
    var beatSecs = [];
    for (var m = 0; m <= total; m++) {
      var beats = tempo.len[m] || 4;
      for (var k3 = 0; k3 < beats; k3++) {
        var barPos = m + k3 / beats;
        var bsArr = new Float32Array([barPos]), ss = new Float32Array(1);
        tempo.barToSec(core, bsArr, ss);
        barLines.push({
          sec: ss[0],
          q: mhsLayer && sfOn ? mhsLayer.qAt(ss[0]) : ss[0],
          major: k3 === 0, bar: m
        });
      }
    }
    barLines.sort(function (a, b) { return a.q - b.q; });

    // --- hit events (for FX + lane flash), sorted by sec. -------------
    var hitEvents = [];
    notes.forEach(function (nt) {
      if (nt.kind === 'dmg') return;
      var kind;
      if (nt.kind === 'trace') kind = nt.crit ? 'trace_crit' : 'trace';
      else if (nt.kind === 'long') kind = nt.crit ? 'long_crit' : 'long';
      else if (nt.kind === 'flick') kind = nt.crit ? 'flick_crit' : 'flick';
      else if (nt.kind === 'relay') kind = nt.crit ? 'long_crit' : 'long';
      else kind = nt.crit ? 'tap_crit' : 'tap';
      hitEvents.push({
        sec: nt.sec, q: nt.q, kind: kind, lane: nt.x / LW - 6, w: nt.w,
        crit: nt.crit, isFlick: nt.kind === 'flick', idx: nt._i
      });
    });
    hitEvents.sort(function (a, b) { return a.sec - b.sec; });

    var dur = 0;
    notes.forEach(function (nt) { dur = Math.max(dur, nt.sec); });
    chains.forEach(function (c) { dur = Math.max(dur, c.pSecs[c.pSecs.length - 1]); });
    dur += 1.5;

    return {
      tempo: tempo, layers: layers, mainLayer: mhsLayer,
      notes: notes, layerIndex: layerIndex, chains: chains,
      chordPairs: chordPairs, barLines: barLines, hitEvents: hitEvents,
      duration: dur, totalBars: total, endBar: total,
      combo: (D.cmb || []).slice(), mhs: D.mhs
    };
  }

  /* ------------------------------------------------------------------ */
  /* Engine                                                               */
  var DEFAULT_SETTINGS = {
    spd: 6, rate: 1, rk: 'all', ap: 0, sl: 1, gd: 0.4, mirror: false,
    noSofran: false, skin: 1, fxVariant: 0,
    bgBrightness: 1, coverOpacity: 0.35,
    ao: 0, manualMs: 0, autoMs: null, vol: 0.8
  };

  function Engine(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.core = null;             // ProsekaWasm core (wasm or JS fallback)
    this.renderer = null;         // GLRenderer
    this.fx = null;               // FxSystem
    this.assetsBase = opts.assetsBase || 'assets/';
    this.onState = opts.onState || function () {};
    this.onSave = opts.onSave || function () {};
    this.audioProvider = opts.audioProvider || null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, opts.settings || {});
    this.drawData = null;
    this.songInfo = null;
    this.playing = false;
    this.cur = -LEAD;
    this._lastFrameNow = -LEAD;
    this._raf = 0;
    this._lastTs = 0;
    this._needDraw = true;
    this._hitPtr = 0;
    this._fxReady = false;
    this._fps = 0; this._fpsN = 0; this._fpsT = 0;
    // audio
    this.ctx = null; this.gain = null; this.src = null;
    this.ab = null;               // {buf, rate} playback buffer (stretched)
    this.origBuf = null;          // original decoded buffer (for export)
    this._audioBase = 0; this._audioT0 = 0; this._audioRate = 1;
    this._latency = { outputMs: null, baseMs: null, contextMs: null, appliedMs: 0 };
    this._tapTest = null;
  }

  Engine.prototype.pps = function () {
    var rate = this.settings.rk === 'keep' ? 1 : this.settings.rate;
    return JY / TT(this.settings.spd) / rate;
  };
  Engine.prototype.zMax = function () { return zOf(this.settings.ap / 100); };

  /* Q(now) per layer: scalar scroll lookup (few layers, per frame). */
  Engine.prototype.qAt = function (t, layer) {
    if (!layer) return t;
    return layer.qAt(t);
  };
  Engine.prototype.mainQ = function (t) {
    var dd = this.drawData;
    if (!dd) return t;
    return dd.mainLayer && !this.settings.noSofran ? dd.mainLayer.qAt(t) : t;
  };

  /* The one public state snapshot. UI reads this and nothing else. */
  Engine.prototype.getState = function () {
    var dd = this.drawData;
    var now = this.cur;
    var bar = 0, bpm = 120, speed = 1;
    if (dd) {
      var out = new Float32Array(2);
      dd.tempo.secToBar(this.core, new Float32Array([Math.max(0, now)]), out);
      bar = out[0]; bpm = out[1];
      var ml = dd.mainLayer;
      speed = ml && !this.settings.noSofran ? ml.speedAtScalar(Math.max(0, now)) : 1;
    }
    return {
      now: now, duration: dd ? dd.duration : 0, end: dd ? dd.duration : 0,
      leadIn: LEAD, bar: bar, bpm: bpm, speed: speed,
      playing: this.playing, settings: this.settings,
      latency: this._latency, fps: this._fps,
      wasm: this.core ? !!this.core.isWasm : false,
      quads: this.renderer ? this.renderer.stats.quads : 0,
      drawCalls: this.renderer ? this.renderer.stats.drawCalls : 0,
      fxLoaded: this._fxReady
    };
  };

  Engine.prototype.setSettings = function (patch, opts) {
    opts = opts || {};
    var before = { sf: this.settings.noSofran, spd: this.settings.spd, rate: this.settings.rate, rk: this.settings.rk };
    Object.assign(this.settings, patch);
    var after = this.settings;
    if (!opts.silent) this.onSave(this.settings);
    if (this.drawData && (before.sf !== after.noSofran)) {
      // Hi-speed on/off changes every scroll position: rebuild DrawData.
      this._rebuildDrawData();
    }
    this._needDraw = true;
    this.requestDraw();
  };

  Engine.prototype._rebuildDrawData = function () {
    if (!this._lastS || !this._lastD) return;
    this.drawData = buildDrawData(this.core, this._lastS, this._lastD, this.settings);
    this._hitPtr = 0;
    if (this.fx) this.fx.clear();
  };

  Engine.prototype.loadChart = function (S, D, songInfo) {
    this._lastS = S; this._lastD = D;
    this.songInfo = songInfo || null;
    this.drawData = buildDrawData(this.core, S, D, this.settings);
    this.cur = -LEAD;
    this._lastFrameNow = -LEAD;
    this._hitPtr = 0;
    if (this.fx) this.fx.clear();
    this._needDraw = true;
    return this.drawData;
  };

  /* ------------------------------------------------------------------ */
  /* Init: WASM + WebGL2 + textures + FX.                               */
  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('image failed: ' + url)); };
      im.src = url;
    });
  }

  Engine.prototype.init = function () {
    var self = this;
    return ProsekaWasm.load(this.assetsBase + '../wasm/proseka_core.wasm')
      .catch(function () { return ProsekaWasm.js; })
      .then(function (core) {
        self.core = core;
        self.renderer = new ProsekaGL.GLRenderer(self.canvas);
        if (!self.renderer.supported) throw new Error('WebGL2 が使えません');
        self.fx = new ProsekaFx.FxSystem(core, self.assetsBase + 'effects/');
        return self._loadSkinAssets(self.settings.skin);
      })
      .then(function () {
        return Promise.all([
          loadImage(self.assetsBase + 'effect.png').then(function (im) { self.renderer.loadTexture('effect', im); }),
          loadImage(self.assetsBase + 'stage.png').then(function (im) { self.renderer.loadTexture('stage', im); }),
          loadImage(self.assetsBase + 'bg_overlay.png').then(function (im) { self.renderer.loadTexture('overlay', im); })
        ]);
      })
      .then(function () { return self.fx.load(self.settings.fxVariant); })
      .then(function () { self._fxReady = true; return self; })
      .catch(function (e) {
        // FX / textures are non-fatal: the player still renders with the
        // procedural fallback colours. WASM failure is already handled by
        // the JS fallback above; only a missing WebGL2 is fatal.
        if (!self.renderer || !self.renderer.supported) throw e;
        if (typeof console !== 'undefined') console.warn('[engine] asset load issue:', e && e.message);
        return self;
      });
  };

  Engine.prototype._loadSkinAssets = function (skin) {
    var self = this;
    var name = skin === 2 ? 'notes_02' : 'notes_01';
    var band = skin === 2 ? 'long_band_02' : 'long_band_01';
    var guide = skin === 2 ? 'guide_02' : 'guide_01';
    return fetch(this.assetsBase + name + '.json').then(function (r) { return r.json(); })
      .then(function (atlas) {
        self.renderer.setAtlas('notes', atlas);
        self.atlas = atlas;
        return loadImage(self.assetsBase + name + '.png');
      })
      .then(function (im) { self.renderer.loadTexture('notes', im); })
      .then(function () { return loadImage(self.assetsBase + band + '.png'); })
      .then(function (im) { self.renderer.loadTexture('band', im); })
      .then(function () { return loadImage(self.assetsBase + guide + '.png'); })
      .then(function (im) { self.renderer.loadTexture('guide', im); });
  };

  Engine.prototype.setSkin = function (skin) {
    var self = this;
    this.settings.skin = skin;
    this.onSave(this.settings);
    return this._loadSkinAssets(skin).then(function () { self._needDraw = true; self.requestDraw(); });
  };

  Engine.prototype.setFxVariant = function (v) {
    var self = this;
    this.settings.fxVariant = v;
    this.onSave(this.settings);
    return this.fx.load(v).then(function () { self._needDraw = true; self.requestDraw(); });
  };

  /* ------------------------------------------------------------------ */
  /* Frame rendering.                                                    */
  Engine.prototype._spriteUV = function (name) {
    var uv = this.renderer.spriteUV('notes', name);
    return uv ? [uv[0], uv[1], uv[2], uv[3]] : null;
  };

  Engine.prototype._noteSprite = function (nt) {
    // kind -> atlas sprite (see tools/make_atlas.py for the naming).
    if (nt.kind === 'relay') return 'gem_' + (nt.crit ? 'crit_l' : 'long_l');
    if (nt.kind === 'trace') return 'body_long_small';
    if (nt.kind === 'long') return nt.crit ? 'body_crit_head' : 'body_long_head';
    if (nt.kind === 'flick') return nt.crit ? 'body_crit_head' : 'body_flick_head';
    if (nt.kind === 'dmg') return 'body_tap_head';
    return nt.crit ? 'body_crit_head' : 'body_tap_head';
  };
  Engine.prototype._noteTint = function (nt) {
    if (nt.kind === 'dmg') return [0.72, 0.58, 1, 1];
    if (nt.kind === 'trace') return [1, 1, 1, 0.9];
    return [1, 1, 1, 1];
  };
  Engine.prototype._flickSprite = function (nt) {
    if (nt.arrow == null) return null;
    var idx = clamp(Math.trunc(nt.w) || 1, 1, 6);
    var dir = Math.abs(nt.arrow) > 0.1 ? 'diag' : 'up';
    var fam = nt.crit ? 'crit' : 'flick';
    return { name: 'flick_' + dir + '_' + fam + '_' + idx, right: nt.arrow > 0, diag: dir === 'diag' };
  };

  Engine.prototype.render = function (now) {
    var r = this.renderer;
    if (!r || !r.supported || !this.drawData) return;
    if (this.viewMode === 'flat') return; // flat view is drawn by FlatView
    var dd = this.drawData, st = this.settings;
    var g = r.resize(this.canvas.clientWidth, this.canvas.clientHeight,
      Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    if (!g) return;
    var sg = st.mirror ? -1 : 1;
    var pps = this.pps();
    var zM = this.zMax();
    var Q = this.mainQ(now);
    var top = JY * (1 - zM);
    var qLo = Q - 0.05 * JY / pps, qHi = Q + (zM + 0.05) * JY / pps;
    r.beginFrame(st.bgBrightness);
    var W = g.W, H = g.H, ox = g.ox, oy = g.oy, Sw = g.Sw, Sh = g.Sh;

    // --- stage: overlay (bg) -> stage image (2048x1176) -> cover overlay.
    r.quadRect('bg', ox, oy, Sw, Sh, [0, 0, 1, 1], [1, 1, 1, 1], 1);
    r.quadRect('stage', ox, oy, Sw, Sh, [0, 0, 1, 1], [1, 1, 1, 1], 1);
    if (st.coverOpacity > 0.005) {
      r.quadRect('overlay', ox, oy, Sw, Sh, [0, 0, 1, 1], [1, 1, 1, st.coverOpacity], 1);
    }
    // Top mask: hide notes above the appearance start (original cover).
    if (this.zMax() > 0.001) {
      var yTop = g.yV + (g.yJ - g.yV) * Math.exp(-KAP * zM);
      r.quadRect('solid', ox, oy, Sw, Math.max(0, yTop - oy), null, [0.07, 0.09, 0.15, 1], 1);
    }

    var core = this.core;
    var pjIn = new Float32Array(8192 * 2), pjOut = new Float32Array(8192 * 4);

    // --- slide chains ---------------------------------------------------
    var bandQuads = [];   // {pts, uv, tint, recip}
    var guideQuads = [];
    var holdChains = [];
    for (var ci = 0; ci < dd.chains.length; ci++) {
      var c = dd.chains[ci];
      if (c.qMax < qLo || c.qMin > qHi) continue;
      // Hold state: head already hit, tail not yet.
      if (!c.deco && c.pSecs[0] <= now && c.pSecs[c.pSecs.length - 1] > now) holdChains.push(c);
      for (var si = 0; si < c.segs.length; si++) {
        var seg = c.segs[si];
        if (seg.q1 < qLo || seg.q0 > qHi) continue;
        var y0 = JY - (seg.q0 - Q) * pps, y1 = JY - (seg.q1 - Q) * pps;
        var up = Math.min(y0, JY), dn = Math.max(y1, top);
        if (up <= dn + 0.01) continue;
        var K = clamp(Math.ceil((up - dn) / 12), 2, 28);
        var n = K + 1;
        var fArr = new Float32Array(n), einArr = new Uint8Array(n), eoutArr = new Uint8Array(n), sArr = new Float32Array(n);
        for (var k = 0; k < n; k++) {
          fArr[k] = (y0 - (up - (up - dn) * k / K)) / (y0 - y1);
          einArr[k] = seg.ein ? 1 : 0; eoutArr[k] = seg.eout ? 1 : 0;
        }
        core.slideEaseBatch(fArr, einArr, eoutArr, sArr, n);
        // Edge lane positions (lp units) at both ends.
        var dl = c.deco ? 0 : 0.05;
        var lL0 = seg.l0 - 6 + dl, lR0 = seg.l0 + seg.w0 - 6 - dl;
        var lL1 = seg.l1 - 6 + dl, lR1 = seg.l1 + seg.w1 - 6 - dl;
        var pin = 0;
        for (var k2 = 0; k2 < n; k2++) {
          var y = up - (up - dn) * k2 / K;
          var z = (JY - y) / JY;
          var s = sArr[k2];
          var xl = lL0 + (lL1 - lL0) * s, xr = lR0 + (lR1 - lR0) * s;
          pjIn[pin++] = xl; pjIn[pin++] = z;
          pjIn[pin++] = xr; pjIn[pin++] = z;
        }
        var m = n * 2;
        core.pjBatch(pjIn.subarray(0, m * 2), pjOut.subarray(0, m * 4), m, g.cx, g.yV, g.yJ, g.LU, sg, KAP);
        for (var k3 = 0; k3 < K; k3++) {
          var a = k3 * 2, b = a + 2;
          var L0 = [pjOut[a * 4], pjOut[a * 4 + 1]], R0 = [pjOut[(a + 1) * 4], pjOut[(a + 1) * 4 + 1]];
          var L1 = [pjOut[b * 4], pjOut[b * 4 + 1]], R1 = [pjOut[(b + 1) * 4], pjOut[(b + 1) * 4 + 1]];
          var w0 = pjOut[a * 4 + 3], w1 = pjOut[b * 4 + 3];
          var pts = [L0, R0, R1, L1];
          var rec = [w0, w0, w1, w1];
          var v0 = k3 / K, v1 = (k3 + 1) / K;
          if (c.deco) {
            var col = c.crit ? [1, 0.74, 0.15] : [0.32, 0.98, 0.63];
            var aFar = 0, aNear = Math.min(1, st.gd * (c.crit ? 0.874 : 1.11));
            // far (k3) -> near (k3+1) along the segment direction (y decreases
            // towards the judgement line when the segment descends).
            var tint = [[col[0], col[1], col[2], aFar], [col[0], col[1], col[2], aFar],
                        [col[0], col[1], col[2], aNear], [col[0], col[1], col[2], aNear]];
            guideQuads.push({ pts: pts, uv: [0, v0, 1, v1], tint: tint, recip: rec });
          } else {
            var base = c.crit ? [0.92, 0.89, 0.60] : [0.42, 0.90, 0.74];
            var al = 0.85 * st.sl;
            bandQuads.push({ pts: pts, uv: null, tint: [base[0], base[1], base[2], al], recip: rec, bucket: 'bandBase' });
            bandQuads.push({ pts: pts, uv: [0, v0, 1, v1], tint: [1, 1, 1, 0.5 * st.sl], recip: rec, bucket: 'band' });
          }
        }
      }
      // Relay gems on the path.
      for (var ri = 0; ri < c.relays.length; ri++) {
        var rl = c.relays[ri];
        if (rl.q < qLo || rl.q > qHi) continue;
        var zr = (rl.q - Q) * pps / JY;
        if (zr < -0.002 || zr > zM) continue;
        var edgeR = this._chainEdgeAt(c, rl.q, pps, Q);
        var laneC = edgeR ? (edgeR[0] + edgeR[1]) / 2 : rl.lane - 6 + 0.5;
        core.pjBatch(new Float32Array([laneC, zr]), pjOut.subarray(0, 4), 1, g.cx, g.yV, g.yJ, g.LU, sg, KAP);
        this._emitGem(r, pjOut, rl.kind, 1, [pjOut[0], pjOut[1], pjOut[3]]);
      }
    }
    guideQuads.forEach(function (q) { r.quad('guide', q.pts, q.uv, q.tint, q.recip); });
    bandQuads.forEach(function (q) { r.quad(q.bucket || 'band', q.pts, q.uv, q.tint, q.recip); });

    // --- visible notes (per-layer binary search, far first) ------------
    var visible = [];
    Object.keys(dd.layerIndex).forEach(function (k) {
      var li = dd.layerIndex[k];
      var arr = li.q;
      var lo = 0, hi = arr.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < qLo) lo = mid + 1; else hi = mid; }
      for (var i = lo; i < arr.length && arr[i] <= qHi; i++) visible.push(li.notes[i]);
    });
    visible.sort(function (a, b) { return b.q - a.q || a._i - b._i; });
    // Batch-project note corners (4) + centre (1) per note.
    var per = 5, total = visible.length * per;
    var inOff = 0;
    for (var ni = 0; ni < visible.length; ni++) {
      var nt = visible[ni];
      var z = (nt.q - Q) * pps / JY;
      if (z < -0.002 || z > zM) { nt._z = -1; continue; }
      nt._z = z;
      var lp0 = nt.x / LW - 6 + 0.06, lp1 = lp0 + nt.w - 0.12;
      var dz = nt.kind === 'trace' ? 0.0125 : 0.0165;
      pjIn[inOff++] = lp0; pjIn[inOff++] = z - dz;
      pjIn[inOff++] = lp1; pjIn[inOff++] = z - dz;
      pjIn[inOff++] = lp1; pjIn[inOff++] = z + dz;
      pjIn[inOff++] = lp0; pjIn[inOff++] = z + dz;
      pjIn[inOff++] = lp0 + nt.w / 2; pjIn[inOff++] = z;
    }
    var nPts = inOff / 2;
    if (nPts) core.pjBatch(pjIn.subarray(0, inOff), pjOut.subarray(0, nPts * 4), nPts, g.cx, g.yV, g.yJ, g.LU, sg, KAP);
    var pi = 0;
    var arrows = [];
    for (var vi = 0; vi < visible.length; vi++) {
      var nt2 = visible[vi];
      if (nt2._z < 0) continue;
      var P = [];
      for (var c4 = 0; c4 < 5; c4++) P.push([pjOut[(pi + c4) * 4], pjOut[(pi + c4) * 4 + 1], pjOut[(pi + c4) * 4 + 3]]);
      pi += 5;
      var z2 = nt2._z;
      if (nt2.kind === 'relay') {
        this._emitGem(r, pjOut, nt2.crit ? 'crit' : 'long', 1, P[4]);
        continue;
      }
      var spr = this._noteSprite(nt2);
      var uv = this._spriteUV(spr);
      if (uv) {
        var rec = [P[0][2], P[1][2], P[2][2], P[3][2]];
        r.quad('notes', [[P[0][0], P[0][1]], [P[1][0], P[1][1]], [P[2][0], P[2][1]], [P[3][0], P[3][1]]],
          uv, this._noteTint(nt2), rec);
      }
      if (nt2.kind === 'trace') {
        this._emitGem(r, pjOut, nt2.crit ? 'crit' : (nt2.arrow != null ? 'flick' : 'long'), 1, P[4]);
      }
      var fl = this._flickSprite(nt2);
      if (fl) arrows.push({ nt: nt2, fl: fl, cx: P[4][0], cy: P[4][1], u: g.LU * P[4][2], z: z2 });
    }
    // Flick arrows above the notes, far first.
    arrows.sort(function (a, b) { return b.z - a.z; });
    for (var ai = 0; ai < arrows.length; ai++) {
      var ar = arrows[ai];
      var uvA = this._spriteUV(ar.fl.name);
      if (!uvA) continue;
      var u = ar.u;
      var fh = 1.5 * u, iw = 2.25 * u;
      var sprW = uvA[4] || 1, sprH = uvA[5] || 1;
      var sc = Math.min(iw / sprW, fh / sprH);
      var w = sprW * sc, h = sprH * sc;
      var x0 = ar.cx - w / 2 + (ar.fl.diag ? (ar.fl.right ? 1 : -1) * u / 4 : 0);
      var y0 = ar.cy + u / 4 - h;
      var uvs = ar.fl.right ? [uvA[2], uvA[1], uvA[0], uvA[3]] : uvA;
      r.quadRect('notes', x0, y0, w, h, uvs, [1, 1, 1, 1], Math.exp(-KAP * ar.z));
    }

    // --- chord lines (white, between simultaneous notes) ---------------
    var chordPts = [];
    for (var ci2 = 0; ci2 < dd.chordPairs.length; ci2++) {
      var pair = dd.chordPairs[ci2];
      var A = dd.notes[pair[0]], B = dd.notes[pair[1]];
      if (A.q < qLo || A.q > qHi || B.q < qLo || B.q > qHi) continue;
      var zA = (A.q - Q) * pps / JY, zB = (B.q - Q) * pps / JY;
      var l0 = A.x / LW - 6 + A.w, l1 = B.x / LW - 6;
      if (l1 - l0 < 0.01) continue;
      var zl = 0.00205;
      chordPts.push([l0, zA - zl, l1, zB - zl, l1, zB + zl, l0, zA + zl]);
    }
    if (chordPts.length) {
      var cin = new Float32Array(chordPts.length * 8);
      for (var ci3 = 0; ci3 < chordPts.length; ci3++) {
        for (var c5 = 0; c5 < 8; c5++) cin[ci3 * 8 + c5] = chordPts[ci3][c5];
      }
      var cout = new Float32Array(chordPts.length * 16);
      core.pjBatch(cin, cout, chordPts.length * 4, g.cx, g.yV, g.yJ, g.LU, sg, KAP);
      for (var ci4 = 0; ci4 < chordPts.length; ci4++) {
        var o = ci4 * 16;
        var pts = [[cout[o], cout[o + 1]], [cout[o + 4], cout[o + 5]], [cout[o + 8], cout[o + 9]], [cout[o + 12], cout[o + 13]]];
        var rec2 = [cout[o + 3], cout[o + 7], cout[o + 11], cout[o + 15]];
        r.quad('solid', pts, null, [1, 1, 1, 0.91], rec2);
      }
    }

    // --- hold beams + rising glints (additive) --------------------------
    for (var hi = 0; hi < holdChains.length; hi++) {
      var hc = holdChains[hi];
      var qNow = Q;
      // Lane interval at the judgement line for this chain.
      var edge = this._chainEdgeAt(hc, qNow, pps, Q);
      if (!edge) continue;
      var l0h = edge[0], l1h = edge[1];
      var pin3 = 0;
      pjIn[pin3++] = l0h; pjIn[pin3++] = 0; pjIn[pin3++] = l1h; pjIn[pin3++] = 0;
      core.pjBatch(pjIn.subarray(0, 4), pjOut.subarray(0, 8), 2, g.cx, g.yV, g.yJ, g.LU, sg, KAP);
      var xl = pjOut[0], xr = pjOut[4];
      var hU = 0.285 * Sh, gw = hU / (1.724 * Sh);
      var tl = g.cx + (xl - g.cx) * (1 + gw), tr = g.cx + (xr - g.cx) * (1 + gw);
      var kcol = hc.crit ? [1, 0.78, 0.24] : [0.2, 0.9, 0.65];
      var beamTint = [[kcol[0], kcol[1], kcol[2], 0], [kcol[0], kcol[1], kcol[2], 0],
                      [kcol[0], kcol[1], kcol[2], 0.34], [kcol[0], kcol[1], kcol[2], 0.34]];
      r.quad('glow', [[tl, g.yJ - hU], [tr, g.yJ - hU], [xr, g.yJ], [xl, g.yJ]], null, beamTint, 1);
      // Frame glow band.
      r.quadRect('glow', xl, g.yJ - 4, xr - xl, 8, null, [kcol[0], kcol[1], kcol[2], 0.35], 1);
      // Rising glints inside the beam (deterministic per hold).
      for (var gj = 0; gj < 14; gj++) {
        var rr = function (q) { return core.randHash(hi + 7, gj * 5 + q); };
        var p = ((now * 1.6 + rr(1)) % 1 + 1) % 1;
        var s2 = Math.max(1.2, g.LU * (0.04 + 0.05 * rr(3)));
        var gx = pjOut[0] + (pjOut[4] - pjOut[0]) * rr(2);
        var gy = g.yJ - p * 0.21 * Sh;
        var al = 0.85 * Math.sin(Math.PI * p);
        r.quadRect('glow', gx - s2 / 2, gy - s2 / 2, s2, s2, null, [1, 1, 1, al], 1);
      }
    }

    // --- hit FX ----------------------------------------------------------
    this._triggerHits(now);
    if (this.fx && this._fxReady) {
      var dt = clamp(now - this._lastFrameNow, 0, 0.1);
      this.fx.step(dt);
      this.fx.emit(r, {
        luScale: g.LU,
        recipAt: function (y) { return clamp((y - g.yV) / Math.max(1, g.yJ - g.yV), 0.02, 1); }
      });
    }
    this._lastFrameNow = now;
    r.endFrame();
  };

  Engine.prototype._emitGem = function (r, pjOut, kind, scale, centre) {
    var g = this.renderer.geom;
    var name = 'gem_' + kind + '_l';
    // Not every kind has a large gem (flick only ships _s); fall back to
    // the same kind's small gem, then to the long gem.
    var uv = this._spriteUV(name) || this._spriteUV('gem_' + kind + '_s') || this._spriteUV('gem_long_l');
    if (!uv || !centre) return;
    var u = g.LU * centre[2];
    var w = 0.88 * u, h = w * ((uv[5] || 100) / (uv[4] || 100));
    r.quadRect('notes', centre[0] - w / 2, centre[1] - h / 2, w, h, uv, [1, 1, 1, 1], centre[2]);
  };

  /* Lane interval (lp units) of a chain at scroll position q. */
  Engine.prototype._chainEdgeAt = function (c, q, pps, Q) {
    var pts = c.pts;
    for (var s = 0; s + 1 < pts.length; s++) {
      var q0 = c.pQs[s], q1 = c.pQs[s + 1];
      if (q < Math.min(q0, q1) - 1e-6 || q > Math.max(q0, q1) + 1e-6) continue;
      var f = (q0 === q1) ? 0 : (q - q0) / (q1 - q0);
      var ein = c.segs[s].ein, eout = c.segs[s].eout;
      var out = new Float32Array(1);
      this.core.slideEaseBatch(new Float32Array([clamp(f, 0, 1)]),
        new Uint8Array([ein ? 1 : 0]), new Uint8Array([eout ? 1 : 0]), out, 1);
      var sv = out[0];
      var dl = c.deco ? 0 : 0.05;
      var l0 = pts[s][1] - 6 + dl + ((pts[s + 1][1] - pts[s][1]) * sv);
      var r0 = pts[s][1] + pts[s][2] - 6 - dl + (((pts[s + 1][1] + pts[s + 1][2]) - (pts[s][1] + pts[s][2])) * sv);
      return [l0, r0];
    }
    return null;
  };

  /* Fire hit FX for events crossed since the previous frame. */
  Engine.prototype.decodeAudio = function (arrayBuffer) {
    var c = this._ensureCtx();
    if (!c) return Promise.reject(new Error('AudioContext が使えません'));
    return c.decodeAudioData(arrayBuffer);
  };

  Engine.prototype.toBar = function (b) {
    var dd = this.drawData;
    if (!dd) return;
    var bars = new Float32Array([Math.max(0, Math.min(dd.totalBars, b))]);
    var out = new Float32Array(1);
    dd.tempo.barToSec(this.core, bars, out);
    this.seek(out[0]);
  };
  Engine.prototype.prevBar = function () {
    var st = this.getState();
    if (this.cur <= 0) return this.seek(-LEAD);
    var f = Math.floor(st.bar + 1e-9);
    this.toBar(st.bar - f > 0.02 ? f : f - 1);
  };
  Engine.prototype.nextBar = function () {
    var st = this.getState();
    this.toBar(Math.floor(st.bar + 1e-9) + 1);
  };
  Engine.prototype.setViewMode = function (v) { this.viewMode = v === 'flat' ? 'flat' : 'game'; this._needDraw = true; };

  Engine.prototype._triggerHits = function (now) {
    var dd = this.drawData;
    if (!dd || !this.fx || !this._fxReady) return;
    var ev = dd.hitEvents;
    var g = this.renderer.geom;
    if (!g) return;
    while (this._hitPtr < ev.length && ev[this._hitPtr].sec <= now) {
      var e = ev[this._hitPtr++];
      if (e.sec < now - 0.95) continue; // too old (after a seek forward)
      var x = g.cx + (this.settings.mirror ? -1 : 1) * (e.lane + e.w / 2) * g.LU; // lane centre at judgement (s=1)
      var kind = e.kind;
      this.fx.hit(kind, x, g.yJ, 1, e.idx * 2654435761 >>> 0);
      this.fx.laneFlash(e.crit ? (e.isFlick ? 'flick_crit' : 'crit') : 'normal', x, g.yJ, 1);
    }
  };

  Engine.prototype.seek = function (t) {
    var dd = this.drawData;
    this.cur = clamp(t, -LEAD, dd ? dd.duration : 0);
    // Reset the hit pointer by binary search; clear live particles.
    var ev = dd ? dd.hitEvents : [];
    var lo = 0, hi = ev.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (ev[m].sec <= this.cur) lo = m + 1; else hi = m; }
    this._hitPtr = lo;
    if (this.fx) this.fx.clear();
    this._lastFrameNow = this.cur;
    this._needDraw = true;
    if (this.playing) this._audioStart();
    // When paused there is no rAF loop, so draw the new position now;
    // otherwise the canvas keeps showing the old frame after a seek.
    this.requestDraw();
  };

  /* ------------------------------------------------------------------ */
  /* Audio: clock, WSOLA stretch, latency, export.                      */
  Engine.prototype._ensureCtx = function () {
    if (!this.ctx) {
      var AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
      if (!AC) return null;
      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.settings.vol;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  };
  Engine.prototype.setVolume = function (v) {
    this.settings.vol = v;
    if (this.gain) this.gain.gain.value = v;
    this.onSave(this.settings);
  };
  /** Effective output latency (seconds) the clock subtracts.
   *  This is the *device* latency only (ctx.outputLatency plus the extra
   *  getOutputTimestamp() reports, e.g. Bluetooth). The manual offset
   *  (manualMs / ao) is NOT here: it shifts the source start offset in
   *  _audioStart, exactly like the original `ao`. */
  Engine.prototype._outputLatencySec = function () {
    var ctx = this.ctx;
    if (!ctx) return 0;
    var base = ctx.outputLatency || 0;
    var extra = 0;
    if (this._latency.contextMs != null) extra = (this._latency.contextMs - base * 1000) / 1000;
    return Math.max(0, base + extra);
  };
  Engine.prototype.audioNow = function () {
    if (!this.ctx || !this.src) return null;
    return this._audioBase + (this.ctx.currentTime - this._outputLatencySec() - this._audioT0) * this._audioRate;
  };
  Engine.prototype._audioStop = function () {
    if (this.src) {
      if (this.playing) {
        var an = this.audioNow();
        if (an != null) this.cur = Math.min(this.drawData ? this.drawData.duration : this.cur, an);
      }
      try { this.src.stop(); } catch (e) {}
      try { this.src.disconnect(); } catch (e) {}
      this.src = null;
    }
  };
  Engine.prototype._audioStart = function () {
    this._audioStop();
    if (!this.ab || !this.playing) return;
    var c = this._ensureCtx();
    if (!c) return;
    var o = this.cur + this.settings.ao + (this.settings.manualMs || 0) / 1000;
    var r = this.ab.rate, off = (this.songInfo && this.songInfo.fs ? this.songInfo.fs : 0) + Math.max(0, o);
    off = off / r;
    if (off >= this.ab.buf.duration) return;
    var s = c.createBufferSource();
    s.buffer = this.ab.buf; s.connect(this.gain);
    this._audioBase = this.cur; this._audioT0 = c.currentTime; this._audioRate = r;
    s.start(this._audioT0 + (o < 0 ? -o / r : 0), off);
    this.src = s;
  };

  Engine.prototype.setPlay = function (on) {
    this.playing = !!on;
    if (on) {
      if (this.drawData && this.cur >= this.drawData.duration - 0.01) this.cur = -LEAD;
      if (this._ensureCtx()) this.ctx.resume();
      this._audioStart();
      this._lastTs = 0;
      this._startLoop();
    } else {
      this._audioStop();
    }
    this._needDraw = true;
  };

  Engine.prototype._startLoop = function () {
    var self = this;
    if (this._raf) return;
    var loop = function (ts) {
      self._raf = 0;
      if (self.playing) {
        var aT = self.audioNow();
        if (aT != null && self.ctx.state === 'running') self.cur = Math.min(self.drawData.duration, aT);
        else {
          var dt = self._lastTs ? Math.min(0.1, Math.max(0, (ts - self._lastTs) / 1000)) : 0;
          self.cur = Math.min(self.drawData.duration, self.cur + dt * self.settings.rate);
        }
        self._lastTs = ts;
        if (self.cur >= self.drawData.duration) { self.cur = self.drawData.duration; self.setPlay(false); }
        self._needDraw = true;
      }
      if (self._needDraw) {
        self._needDraw = false;
        self.render(self.cur);
        self._fpsN++; var nowMs = (typeof performance !== 'undefined' ? performance.now() : 0);
        if (nowMs - self._fpsT > 1000) { self._fps = self._fpsN * 1000 / Math.max(1, nowMs - self._fpsT); self._fpsN = 0; self._fpsT = nowMs; }
        self.onState(self.getState());
      }
      if (self.playing && !self._raf && !(typeof document !== 'undefined' && document.hidden)) {
        self._raf = requestAnimationFrame(loop);
      }
    };
    this._raf = requestAnimationFrame(loop);
  };

  Engine.prototype.requestDraw = function () {
    this._needDraw = true;
    if (!this._raf && !this.playing) {
      this.render(this.cur);
      this._needDraw = false;
      this.onState(this.getState());
    }
  };

  /* ---- vocal loading (provider supplies the network/cache access) --- */
  Engine.prototype.loadVocal = function (assetName, onProgress) {
    var self = this;
    if (!this.audioProvider) return Promise.reject(new Error('audio provider がありません'));
    this._audioStop();
    this.ab = null;
    return this.audioProvider.fetchAudio(assetName)
      .then(function (buf) {
        self.origBuf = buf;
        var rate = self.settings.rate;
        if (rate < 1) {
          return self.stretch(buf, rate, onProgress).then(function (stretched) {
            self.ab = { buf: stretched, rate: rate };
          });
        }
        self.ab = { buf: buf, rate: 1 };
      })
      .then(function () { if (self.playing) self._audioStart(); });
  };

  /* ---- WSOLA time-stretch (pitch preserving), ported from the original player. */
  Engine.prototype.stretch = function (b, r, tick) {
    var self = this;
    var yd = function () { return new Promise(function (res) { var ch = new MessageChannel(); ch.port1.onmessage = function () { ch.port1.close(); res(); }; ch.port2.postMessage(0); }); };
    return (async function () {
      var n = b.length, C = b.numberOfChannels, N = 2048, H = N >> 1;
      var X = [], mo = new Float32Array(n);
      for (var c = 0; c < C; c++) {
        var x = b.getChannelData(c); X.push(x);
        for (var i = 0; i < n; i++) mo[i] += x[i] / C;
      }
      var dn = n >> 2, dm = new Float32Array(dn), w = new Float32Array(N);
      var L = Math.ceil(n / r), Y = X.map(function () { return new Float32Array(L + N); });
      for (var j = 0; j < dn; j++) dm[j] = (mo[4 * j] + mo[4 * j + 1] + mo[4 * j + 2] + mo[4 * j + 3]) / 4;
      for (var i2 = 0; i2 < N; i2++) w[i2] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i2 / N);
      var ssd = function (a, p, q, len, st) { var s = 0; for (var i = 0; i < len; i += st) { var d = a[p + i] - a[q + i]; s += d * d; } return s; };
      var prev = 0, t = performance.now();
      for (var k = 0; ; k++) {
        var o = k * H, ideal = Math.round(o * r);
        if (ideal >= n) break;
        var s = prev, e0 = Infinity, bi = 0, q;
        var lo = Math.max(0, prev - 512), hi = Math.min(n - N, prev + 512);
        for (q = lo; q <= hi; q += 4) { var e = ssd(dm, q >> 2, ideal >> 2, H >> 2, 2); if (e < e0) { e0 = e; bi = q; } }
        e0 = Infinity;
        for (q = Math.max(0, bi * 4 - 4); q <= Math.min(n - N, bi * 4 + 4); q++) { var e2 = ssd(mo, q, ideal, H, 4); if (e2 < e0) { e0 = e2; s = q; } }
        for (var c2 = 0; c2 < C; c2++) { var xx = X[c2], y = Y[c2]; for (var i3 = 0; i3 < N; i3++) y[o + i3] += xx[s + i3] * w[i3]; }
        prev = s;
        if (performance.now() - t > 12) { if (tick) await tick(ideal / n); t = performance.now(); }
      }
      var ctx = self._ensureCtx();
      if (!ctx) throw new Error('AudioContext が使えません');
      var out = ctx.createBuffer(C, L, b.sampleRate);
      Y.forEach(function (y, c3) { out.copyToChannel(y.subarray(0, L), c3); });
      return out;
    })();
  };

  /* ---- output latency: automatic measurement -------------------------- */
  Engine.prototype.measureLatency = function () {
    var ctx = this._ensureCtx();
    if (!ctx) return null;
    var out = { outputMs: null, baseMs: null, contextMs: null, appliedMs: 0 };
    if (typeof ctx.outputLatency === 'number') out.outputMs = ctx.outputLatency * 1000;
    if (typeof ctx.baseLatency === 'number') out.baseMs = ctx.baseLatency * 1000;
    try {
      if (typeof ctx.getOutputTimestamp === 'function') {
        var ts = ctx.getOutputTimestamp();
        if (ts && typeof ts.outputLatency === 'number') out.contextMs = ts.outputLatency * 1000;
        if (ts && typeof ts.contextLatency === 'number') out.contextMs = (out.contextMs || 0) + ts.contextLatency * 1000;
      }
    } catch (e) {}
    // The clock already subtracts ctx.outputLatency; the *extra* part
    // getOutputTimestamp reports (e.g. Bluetooth on Chrome) becomes the
    // automatic correction. Manual ms stays separate on top.
    var extra = 0;
    if (out.contextMs != null && out.outputMs != null) extra = Math.max(0, out.contextMs - out.outputMs);
    else if (out.contextMs != null) extra = out.contextMs;
    out.appliedMs = extra;
    // The clock already subtracts outputLatency (+extra); report it so the
    // UI can show the total automatic correction in effect.
    out.clockMs = (out.outputMs || 0) + extra;
    this._latency = out;
    this.settings.autoMs = Math.round(extra);
    this.onSave(this.settings);
    return out;
  };

  /* ---- tap calibration: tap in time with the click, get a suggested offset. */
  Engine.prototype.startTapTest = function (clicks, intervalMs, onDone) {
    var ctx = this._ensureCtx();
    if (!ctx) return null;
    var self = this;
    var times = [];
    var t0 = ctx.currentTime + 0.3;
    var osc, gain;
    var schedule = function (i) {
      var t = t0 + i * intervalMs / 1000;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = i === 0 ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.1);
      times.push({ ctxTime: t, wallTime: performance.now() + (t - ctx.currentTime) * 1000 });
    };
    for (var i = 0; i < clicks; i++) schedule(i);
    var taps = [];
    var tapCount = 0;
    var done = false;
    var finish = function () {
      if (done) return; done = true;
      self._finishTapTest(taps, onDone);
    };
    setTimeout(finish, (t0 - ctx.currentTime) * 1000 + clicks * intervalMs + 1200);
    this._tapTest = {
      clicks: clicks, times: times,
      tap: function () {
        if (done) return;
        tapCount++;
        if (tapCount <= 2) return; // entrainment: the first two taps are warm-up
        var now = performance.now();
        // Match the tap to the nearest scheduled click (wall-clock estimate).
        var best = null, bestD = Infinity;
        times.forEach(function (c) { var d = Math.abs(now - c.wallTime); if (d < bestD) { bestD = d; best = c; } });
        if (best && bestD < intervalMs * 0.75) taps.push(now - best.wallTime);
        if (taps.length >= clicks - 2) finish();
      },
      finish: finish
    };
    return this._tapTest;
  };
  Engine.prototype._finishTapTest = function (taps, onDone) {
    if (!this._tapTest) return;
    this._tapTest = null;
    if (!taps.length) { if (onDone) onDone(null); return; }
    taps.sort(function (a, b) { return a - b; });
    var median = taps[Math.floor(taps.length / 2)];
    // Tap later than the click means the sound is heard late: shift the
    // audio earlier by the median (negative manualMs = sound earlier).
    var suggestedMs = -Math.round(median);
    var res = { taps: taps, medianMs: Math.round(median), suggestedManualMs: suggestedMs };
    if (onDone) onDone(res);
    return res;
  };

  /* ---- export audio (separate from the playback buffer) --------------- */
  Engine.prototype.exportWav = function (rate, onProgress) {
    var self = this;
    if (!this.origBuf) return Promise.reject(new Error('書き出す音源が読み込まれていません'));
    var r = rate || this.settings.rate;
    var work = r < 1 ? this.stretch(this.origBuf, r, onProgress) : Promise.resolve(this.origBuf);
    return work.then(function (buf) {
      var n = buf.length, C = buf.numberOfChannels, sr = buf.sampleRate;
      var bytes = 44 + n * C * 2;
      var ab = new ArrayBuffer(bytes), dv = new DataView(ab);
      var ws = function (o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      ws(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); ws(8, 'WAVE'); ws(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, C, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr * C * 2, true); dv.setUint16(32, C * 2, true);
      dv.setUint16(34, 16, true); ws(36, 'data'); dv.setUint32(40, n * C * 2, true);
      var chans = [];
      for (var c = 0; c < C; c++) chans.push(buf.getChannelData(c));
      var o = 44;
      for (var i = 0; i < n; i++) {
        for (var c2 = 0; c2 < C; c2++) {
          var v = Math.max(-1, Math.min(1, chans[c2][i]));
          dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2;
        }
      }
      return { blob: new Blob([ab], { type: 'audio/wav' }), sampleRate: sr, seconds: n / sr, rate: r };
    });
  };

  global.ProsekaEngine = {
    Engine: Engine, buildDrawData: buildDrawData, TempoMap: TempoMap,
    ScrollLayer: ScrollLayer, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    JY: JY, LW: LW, LEAD: LEAD, KAP: KAP, ZF: ZF, SF: SF, zOf: zOf
  };
})(typeof window !== 'undefined' ? window : globalThis);
