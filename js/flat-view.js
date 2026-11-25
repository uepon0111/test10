/* FlatView: the SVG "chart playback" view (譜面再生画面).
 *
 * Ported from the original playerMain drawFlat() with the same geometry
 * (LW=20, JY=480, bezier slide edges, pooled SVG elements). It reads the
 * same DrawData as the WebGL2 game view, so both views always agree on
 * time, tempo and hi-speed. The game view is the default; this view is
 * kept for the V toggle and as the reference rendering.
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var LW = 20, ML = 40, SW = 12 * LW, VW = ML + SW + 16, VH = 560, JY = 480;

  function el(tag, at, p) {
    var e = document.createElementNS(NS, tag);
    for (var k in at) e.setAttribute(k, at[k]);
    if (p) p.appendChild(e);
    return e;
  }
  function setT(e, s) { if (e._s !== s) { e._s = s; e.textContent = s; } }

  // --- slide edge math (identical to the original player) ---------------
  function tIn(f) { return 2 * Math.cos(Math.acos(-f) / 3 + 4.1887902047863905); }
  function easeS(f, ein, eout) {
    if (!ein && !eout) return f;
    var t;
    if (ein && eout) { var g = f - 0.5, r = Math.sqrt(g * g + 0.0625); t = 0.5 + Math.cbrt((g + r) / 2) + Math.cbrt((g - r) / 2); }
    else t = ein ? tIn(f) : 1 - tIn(1 - f);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }
  var EX = [0, 0];
  function lx(c, i) { return c.pts[i][1] * LW + (c.deco ? 0 : 1); }
  function rx(c, i) { return (c.pts[i][1] + c.pts[i][2]) * LW - (c.deco ? 0 : 1); }
  function curves(c, ys, i) {
    var y0 = ys[i], y1 = ys[i + 1], m = (y0 + y1) / 2;
    var ein = c.e[i] === 2, eout = c.e[i] === 5 || c.e[i] === 6;
    return [[[lx(c, i), y0], [lx(c, i), ein ? m : y0], [lx(c, i + 1), eout ? m : y1], [lx(c, i + 1), y1]],
            [[rx(c, i), y0], [rx(c, i), ein ? m : y0], [rx(c, i + 1), eout ? m : y1], [rx(c, i + 1), y1]]];
  }
  function edgeX(c, ys, i, y) {
    var y0 = ys[i], d = ys[i + 1] - y0, e = c.e[i], s = 0.5;
    if (Math.abs(d) >= 1e-9) {
      var f = (y - y0) / d; f = f < 0 ? 0 : f > 1 ? 1 : f;
      s = easeS(f, e === 2, e === 5 || e === 6);
    }
    var a = lx(c, i), b = rx(c, i);
    EX[0] = a + (lx(c, i + 1) - a) * s; EX[1] = b + (rx(c, i + 1) - b) * s;
  }
  function fq(v) { return Math.round(v * 10) / 10; }
  var FBN = 8, FBAND = [], FBODY = [['rgb(107,229,188)', 'rgb(168,235,200)'], ['rgb(234,226,153)', 'rgb(238,233,180)']];
  for (var j = 1; j < FBN; j++) FBAND.push([0.5 * (FBN - j) / FBN, 0.73 * Math.pow((j + 0.5) / FBN, 1.7)]);
  function fSegs(c, ys) { var a = []; for (var i = 0; i < c.pts.length - 1; i++) a.push(curves(c, ys, i)); return a; }
  function fRibbon(sg, fa, fb) {
    var P = function (s, k, f) { var l = s[0][k], r = s[1][k]; return fq(l[0] + (r[0] - l[0]) * f) + ',' + fq(l[1]); };
    var n = sg.length, d = 'M' + P(sg[0], 0, fa);
    for (var i = 0; i < n; i++) { var s = sg[i]; d += 'C' + P(s, 1, fa) + ' ' + P(s, 2, fa) + ' ' + P(s, 3, fa); }
    d += 'L' + P(sg[n - 1], 3, fb);
    for (var k = n - 1; k >= 0; k--) { var s2 = sg[k]; d += 'C' + P(s2, 2, fb) + ' ' + P(s2, 1, fb) + ' ' + P(s2, 0, fb); }
    return d + 'Z';
  }
  function fEdges(sg, o) {
    var d = '';
    for (var e = 0; e < 2; e++) {
      var P = function (s, k) { return fq(s[e][k][0] + (e ? -o : o)) + ',' + fq(s[e][k][1]); };
      d += 'M' + P(sg[0], 0);
      for (var i = 0; i < sg.length; i++) { var s = sg[i]; d += 'C' + P(s, 1) + ' ' + P(s, 2) + ' ' + P(s, 3); }
    }
    return d;
  }

  function FlatView(svgEl, engine) {
    this.svg = svgEl;
    this.engine = engine;
    this.tp = 0;
    this._buildStage();
  }

  FlatView.prototype._buildStage = function () {
    var stage = this.svg;
    stage.setAttribute('viewBox', '0 0 ' + VW + ' ' + VH);
    var defs = stage.querySelector('defs') || el('defs', {}, stage);
    this.defs = defs;
    el('rect', { x: -6, y: 0, width: SW + 12, height: JY + 2 }, el('clipPath', { id: 'clipH' }, defs));
    [['gGl', '82,250,162', 1], ['gGc', '255,188,39', 0.874]].forEach(function (gdef) {
      var g = el('linearGradient', { id: gdef[0], gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 0, y2: JY }, defs);
      el('stop', { offset: 0, 'stop-color': 'rgb(' + gdef[1] + ')', 'stop-opacity': 0 }, g);
      el('stop', { offset: 1, 'stop-color': 'rgb(' + gdef[1] + ')', 'stop-opacity': gdef[2] }, g);
    });
    var root = el('g', { transform: 'translate(' + ML + ' 0)' }, stage), bg = el('g', {}, root);
    for (var i = 0; i < 12; i++) el('rect', { x: i * LW, y: 0, width: LW, height: JY, fill: i % 2 ? '#19263a' : '#1d2c42' }, bg);
    for (var i2 = 0; i2 <= 12; i2++) el('line', { x1: i2 * LW, x2: i2 * LW, y1: 0, y2: JY, stroke: '#394b63', 'stroke-width': i2 % 12 ? 1 : 1.5 }, bg);
    el('rect', { x: -6, y: JY, width: SW + 12, height: VH - JY, fill: '#0d1524' }, bg);
    this.gL = el('g', {}, root);
    this.gX = el('g', {}, el('g', { 'clip-path': 'url(#clipH)' }, root));
    this.gP = el('g', {}, this.gX);
    this.gN = el('g', {}, this.gX);
    this.gA = el('g', {}, this.gX);
    this.cov = el('rect', { x: -ML, y: 0, width: VW, height: 0, fill: '#111827' }, root);
    this.bl = el('rect', { x: -4, y: 0, width: SW + 8, height: 2, rx: 1, fill: '#ffa94d' }, root);
    el('rect', { x: -6, y: JY - 6, width: SW + 12, height: 12, fill: '#8ef0e2', opacity: 0.14 }, root);
    el('rect', { x: -4, y: JY - 1.5, width: SW + 8, height: 3, rx: 1.5, fill: '#e8fffb', opacity: 0.92 }, root);
    var self = this;
    var mkPool = function (g, tag, at, fn) {
      var els = [], used = 0;
      return function (l1, l2) {
        var n1 = l1.length, n = n1 + (l2 ? l2.length : 0);
        for (var i = 0; i < n; i++) {
          var e = els[i];
          if (!e) { e = el(tag, at, g); els.push(e); }
          else if (i >= used) e.removeAttribute('display');
          fn(e, i < n1 ? l1[i] : l2[i - n1]);
        }
        for (var k = n; k < used; k++) els[k].setAttribute('display', 'none');
        used = n;
      };
    };
    var useFn = function (e, a) {
      if (e._h !== a[0]) { e._h = a[0]; e.setAttribute('href', '#' + a[0]); }
      e.setAttribute('x', a[1].toFixed(1)); e.setAttribute('y', a[2].toFixed(1));
    };
    this.pMin = mkPool(this.gL, 'rect', { x: 0, width: SW, height: 1, fill: '#2e4058' }, function (e, y) { e.setAttribute('y', (y - 0.5).toFixed(1)); });
    this.pMaj = mkPool(this.gL, 'rect', { x: -4, width: SW + 4, height: 1.6, fill: '#7b91ad' }, function (e, y) { e.setAttribute('y', (y - 0.8).toFixed(1)); });
    this.pLab = mkPool(this.gL, 'text', { x: -8, 'text-anchor': 'end', 'font-size': 11, 'font-weight': 700, fill: '#d0dbea' }, function (e, a) { e.setAttribute('y', (a[0] + 4).toFixed(1)); setT(e, String(a[1])); });
    this.pPath = mkPool(this.gP, 'path', {}, function (e, a) {
      e.setAttribute('d', a[0]); e.setAttribute('fill', a[1]); e.setAttribute('fill-opacity', a[2]);
      if (a[3]) { e.setAttribute('stroke', a[3]); e.setAttribute('stroke-width', a[4]); e.setAttribute('stroke-opacity', a[5]); }
      else e.setAttribute('stroke', 'none');
    });
    this.pN = mkPool(this.gN, 'use', {}, useFn);
    this.pA = mkPool(this.gA, 'use', {}, useFn);
    this.YS = []; this.VIS = [];
    this.FA = { mj: [], mn: [], lb: [], pg: [], pp: [], ga: [], vn: [], va: [] };
  };

  FlatView.prototype.applyAp = function (ap) {
    this.tp = JY * ap / 100;
    var clp = this.defs.querySelector('#clipH rect');
    if (clp) { clp.setAttribute('y', this.tp); clp.setAttribute('height', JY + 2 - this.tp); }
    this.cov.setAttribute('height', this.tp);
    this.bl.setAttribute('y', this.tp - 1);
    this.bl.setAttribute('display', this.tp > 0 ? 'inline' : 'none');
  };

  FlatView.prototype.setMirror = function (mir) {
    this.gX.setAttribute('transform', mir ? 'translate(' + SW + ' 0) scale(-1 1)' : '');
  };

  FlatView.prototype.draw = function (now) {
    var engine = this.engine, dd = engine.drawData;
    if (!dd) return;
    var st = engine.settings;
    var pps = engine.pps(), tp = this.tp;
    var sl = st.sl, gd = st.gd;
    var t = now;
    var layers = dd.layers;
    var Q = function (h) {
      if (st.noSofran || h == null) return t;
      var l = layers[String(h)];
      return l ? l.qAt(t) : t;
    };
    var qm = Q(dd.mhs);
    var FA = this.FA;
    var mj = FA.mj, mn = FA.mn, lb = FA.lb, pg = FA.pg, pp = FA.pp, ga = FA.ga, vn = FA.vn, va = FA.va;
    mj.length = mn.length = lb.length = pg.length = pp.length = ga.length = vn.length = va.length = 0;
    // Bar lines.
    var bl = dd.barLines;
    var qlo = qm - 1 / pps, qhi = qm + (JY - tp + 4) / pps;
    var a = 0, b = bl.length;
    while (a < b) { var m = (a + b) >> 1; if (bl[m].q < qlo) a = m + 1; else b = m; }
    for (; a < bl.length && bl[a].q <= qhi; a++) {
      var l = bl[a], y = JY - (l.q - qm) * pps;
      if (l.major) { mj.push(y); lb.push([y, l.bar]); } else mn.push(y);
    }
    this.pMin(mn); this.pMaj(mj); this.pLab(lb);

    // Chains.
    for (var ci = 0; ci < dd.chains.length; ci++) {
      var c = dd.chains[ci];
      if (c._one) {
        var bq = Q(c.pts[0][3]);
        if (JY - (c._qa - bq) * pps < tp - 30 || JY - (c._qb - bq) * pps > JY + 4) continue;
      }
      var ys = this.YS, nq = c.pts.length;
      ys.length = nq;
      var lo = 1e9, hi = -1e9;
      for (var i = 0; i < nq; i++) {
        var y = JY - (c.pQs[i] - Q(c.pts[i][3])) * pps;
        ys[i] = y; if (y < lo) lo = y; if (y > hi) hi = y;
      }
      if (hi < tp - 30 || lo > JY + 4) continue;
      var sg = fSegs(c, ys);
      if (c.deco) pg.push([fRibbon(sg, 0, 1), c.crit ? 'url(#gGc)' : 'url(#gGl)', gd]);
      else {
        var c0c = FBODY[c.crit ? 1 : 0];
        pp.push([fEdges(sg, 0), 'none', 1, 'rgb(0,10,20)', 1.6, 0.55 * sl],
                [fRibbon(sg, 0, 1), c0c[0], 0.85 * sl]);
        var pv = 0;
        for (var fi = 0; fi < FBAND.length; fi++) {
          var f = FBAND[fi][0], mm = FBAND[fi][1];
          pp.push([fRibbon(sg, 0, f) + fRibbon(sg, 1 - f, 1), c0c[1], (1 - (1 - mm) / (1 - pv)) * sl]);
          pv = mm;
        }
        pp.push([fEdges(sg, 0.6), 'none', 1, 'rgb(255,255,255)', 1.2, 0.3 * sl]);
      }
      for (var ri = 0; ri < c.relays.length; ri++) {
        var r = c.relays[ri];
        var ym = JY - (r.q - Q(r.h)) * pps;
        if (ym < tp - 20 || ym > JY + 8) continue;
        edgeX(c, ys, r.seg, ym);
        ga.push([r.s, (EX[0] + EX[1]) / 2, ym]);
      }
    }
    this.pPath(pg, pp);

    // Notes (visible window per layer, original draw order: index desc).
    var VIS = this.VIS;
    VIS.length = 0;
    var nl = 0, mo = true;
    var layerIndex = dd.layerIndex;
    for (var k in layerIndex) {
      var li = layerIndex[k];
      var hs = k === '__none' ? null : +k;
      var qb = Q(hs);
      var qlo2 = qb - 12 / pps, qhi2 = qb + (JY - tp + 110) / pps;
      var lo2 = 0, hi2 = li.notes.length;
      while (lo2 < hi2) { var m2 = (lo2 + hi2) >> 1; if (li.notes[m2].q < qlo2) lo2 = m2 + 1; else hi2 = m2; }
      var s0 = VIS.length;
      for (; lo2 < li.notes.length && li.notes[lo2].q <= qhi2; lo2++) VIS.push(li.notes[lo2]);
      if (VIS.length > s0) { nl++; }
    }
    if (nl > 1) VIS.sort(function (u, v) { return v._i - u._i; });
    else VIS.reverse();
    for (var vi = 0; vi < VIS.length; vi++) {
      var n = VIS[vi];
      var y2 = JY - (n.q - Q(n.hs)) * pps;
      if (y2 < tp - 110 || y2 > JY + 12) continue;
      if (n.s) vn.push([n.s, n.x + 1, y2]);
      for (var ai = 0; ai < n.a.length; ai++) va.push([n.a[ai], n.x + n.w * LW / 2, y2]);
    }
    this.pN(vn);
    this.pA(ga, va);
  };

  global.ProsekaFlat = { FlatView: FlatView, LW: LW, JY: JY };
})(typeof window !== 'undefined' ? window : globalThis);
