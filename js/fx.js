/* FX: MikuMikuWorld-derived particle system.
 *
 * Source data: assets/effects/{0,1}/fx_*.json (25 definitions x 2 patterns).
 * Each file is a Unity ParticleSystem export (root emitter + `children`
 * emitters). This module converts them into compact runtime defs:
 *   lifetime / size / colour-over-lifetime curves -> 64-entry LUTs,
 *   textureSheetAnimation (tilesX x tilesY, startFrame) -> one tile of
 *   assets/effect.png, emission bursts -> spawn counts, shape -> spawn disc.
 * Particles live in fixed per-def pools (no per-frame allocation); the
 * physics step (position/velocity/life + size/alpha LUT sampling) runs in
 * the Rust/WASM core (js/wasm-loader.js) with the JS kernels as fallback.
 * Rendering is additive textured quads on the WebGL2 renderer.
 *
 * Units: 1 Unity unit = FX_UNIT_LU lane-widths (0.42), calibrated so a
 * "gen" glow (startSize 2.688) spans ~1.1 lane widths at the judgement
 * line, matching the original Canvas2D burst radius (~0.5-1.1 LU).
 */
(function (global) {
  'use strict';

  var FX_UNIT_LU = 0.42;
  var LUT_N = 64;
  var BUCKET_CAP = 256;

  /* ---------- curve helpers (Unity AnimationCurve, mode 1 = curve) ----- */
  function curveValue(keys, t) {
    if (!keys || !keys.length) return 1;
    if (t <= keys[0].time) return keys[0].value;
    var last = keys[keys.length - 1];
    if (t >= last.time) return last.value;
    for (var i = 0; i + 1 < keys.length; i++) {
      var a = keys[i], b = keys[i + 1];
      if (t >= a.time && t <= b.time) {
        var dt = b.time - a.time;
        if (dt <= 0) return b.value;
        var u = (t - a.time) / dt;
        // Cubic Hermite with the stored tangents (Unity weighted tangents
        // approximated by plain Hermite; sampled to a LUT, so the error
        // stays inside one LUT step).
        var m0 = (a.outTangent || 0) * dt, m1 = (b.inTangent || 0) * dt;
        var u2 = u * u, u3 = u2 * u;
        return (2 * u3 - 3 * u2 + 1) * a.value + (u3 - 2 * u2 + u) * m0
          + (-2 * u3 + 3 * u2) * b.value + (u3 - u2) * m1;
      }
    }
    return last.value;
  }
  function curveLUT(keys, fallback) {
    var lut = new Float32Array(LUT_N);
    for (var i = 0; i < LUT_N; i++) {
      var t = i / (LUT_N - 1);
      lut[i] = keys && keys.length ? curveValue(keys, t) : fallback;
    }
    return lut;
  }
  function gradientLUT(keys, channel) {
    // keys: [{time, r, g, b, a}] -> LUT of one channel (0..1)
    var lut = new Float32Array(LUT_N);
    for (var i = 0; i < LUT_N; i++) {
      var t = i / (LUT_N - 1);
      if (!keys || !keys.length) { lut[i] = channel === 'a' ? 1 : 1; continue; }
      var v = 1;
      if (t <= keys[0].time) v = keys[0][channel];
      else {
        var last = keys[keys.length - 1];
        if (t >= last.time) v = last[channel];
        else for (var j = 0; j + 1 < keys.length; j++) {
          if (t >= keys[j].time && t <= keys[j + 1].time) {
            var f = (t - keys[j].time) / Math.max(1e-6, keys[j + 1].time - keys[j].time);
            v = keys[j][channel] + (keys[j + 1][channel] - keys[j][channel]) * f;
            break;
          }
        }
      }
      lut[i] = v;
    }
    return lut;
  }
  function constOrRandom(v, rnd) {
    // Unity MinMaxCurve: mode 0 = constant, mode 2 = random between two constants.
    if (!v) return 0;
    if (v.mode === 2) return v.randomMin + rnd() * Math.max(0, v.randomMax - v.randomMin);
    if (v.mode === 1 && v.curveMin && v.curveMin.length) return curveValue(v.curveMin, 0);
    return v.constant || 0;
  }
  function tileIndex(tsa) {
    if (!tsa) return { tilesX: 1, tilesY: 1, frame: 0 };
    var tx = tsa.numTilesX || 1, ty = tsa.numTilesY || 1;
    var start = tsa.startFrame ? (tsa.startFrame.constant || 0) : 0;
    // startFrame is stored normalised: frame = start * tilesX * tilesY.
    var frame = Math.round(start * tx * ty);
    frame = Math.max(0, Math.min(tx * ty - 1, frame));
    return { tilesX: tx, tilesY: ty, frame: frame };
  }

  /* ---------- definition conversion ------------------------------------ */
  function convertEmitter(json, depth) {
    var def = {
      name: json.name || 'emitter',
      maxParticles: json.maxParticles || 1,
      duration: json.duration || 1,
      loop: !!json.loop,
      startLifetime: json.startLifetime || null,
      startSpeed: json.startSpeed || null,
      startSizeX: json.startSize ? json.startSize.x : null,
      startSizeY: json.startSize ? json.startSize.y : null,
      startRotationZ: json.startRotation ? json.startRotation.z : null,
      startColor: json.startColor || null,
      gravityModifier: json.gravityModifier ? (json.gravityModifier.constant || 0) : 0,
      bursts: (json.emission && json.emission.bursts) ? json.emission.bursts : [],
      rateOverTime: json.emission && json.emission.rateOverTime ? (json.emission.rateOverTime.constant || 0) : 0,
      shape: json.shape || null,
      sizeLUT: null, sizeYLUT: null, alphaLUT: null, colorLUT: null,
      velXLUT: null, velYLUT: null, forceXLUT: null, forceYLUT: null, rotLUT: null,
      tiles: tileIndex(json.textureSheetAnimation),
      rendererMode: json.renderer ? json.renderer.mode : 0,
      order: json.renderer ? (json.renderer.order || 0) : 0,
      lengthScale: json.renderer ? (json.renderer.lengthScale || 1) : 1,
      offset: json.transform && json.transform.position ? json.transform.position : { x: 0, y: 0, z: 0 },
      children: []
    };
    if (json.sizeOverLifetime) {
      def.sizeLUT = curveLUT(json.sizeOverLifetime.x ? json.sizeOverLifetime.x.curveMin : null, 1);
      if (json.sizeOverLifetime.y) def.sizeYLUT = curveLUT(json.sizeOverLifetime.y.curveMin, 1);
    }
    if (json.colorOverLifetime) {
      var g = json.colorOverLifetime.gradientKeysMin || json.colorOverLifetime.gradientKeysMax || [];
      def.alphaLUT = gradientLUT(g, 'a');
      def.colorLUT = { r: gradientLUT(g, 'r'), g: gradientLUT(g, 'g'), b: gradientLUT(g, 'b') };
    }
    if (json.velocityOverLifetime) {
      var v = json.velocityOverLifetime;
      if (v.x) def.velXLUT = curveLUT(v.x.curveMin, 0);
      if (v.y) def.velYLUT = curveLUT(v.y.curveMin, 0);
    }
    if (json.forceOverLifetime && json.forceOverLifetime.value) {
      var fv = json.forceOverLifetime.value;
      if (fv.x) def.forceXLUT = curveLUT(fv.x.curveMin, 0);
      if (fv.y) def.forceYLUT = curveLUT(fv.y.curveMin, 0);
    }
    if (json.rotationOverLifetime && json.rotationOverLifetime.z) {
      def.rotLUT = curveLUT(json.rotationOverLifetime.z.curveMin, 0);
    }
    if (depth < 4 && json.children) {
      for (var i = 0; i < json.children.length; i++) {
        def.children.push(convertEmitter(json.children[i], depth + 1));
      }
    }
    return def;
  }

  /* Hit kind -> [gen, aura, flash] definition file names. */
  var HIT_MAP = {
    tap: ['fx_note_normal_gen', 'fx_note_normal_aura'],
    tap_crit: ['fx_note_critical_normal_gen', 'fx_note_critical_normal_aura'],
    flick: ['fx_note_flick_gen', 'fx_note_flick_aura', 'fx_note_flick_flash'],
    flick_crit: ['fx_note_critical_flick_gen', 'fx_note_critical_flick_aura', 'fx_note_critical_flick_flash'],
    long: ['fx_note_long_gen', 'fx_note_long_aura'],
    long_crit: ['fx_note_critical_long_gen', 'fx_note_critical_long_aura'],
    long_hold: ['fx_note_long_hold_gen'],
    long_hold_crit: ['fx_note_critical_long_hold_gen'],
    hold_aura: ['fx_note_long_hold_via_aura'],
    hold_aura_crit: ['fx_note_critical_long_hold_via_aura'],
    trace: ['fx_note_trace_aura'],
    trace_crit: ['fx_note_critical_trace_aura']
  };
  var LANE_MAP = { normal: 'fx_lane_default', crit: 'fx_lane_critical', flick_crit: 'fx_lane_critical_flick' };

  /* ---------- pool ------------------------------------------------------ */
  function FxSystem(core, baseUrl) {
    this.core = core;
    this.baseUrl = baseUrl || 'assets/effects/';
    this.variant = 0;
    this.defs = {};      // name -> def (root emitters only, children inline)
    this.buckets = {};   // defId -> {def, state, size, alpha, cursor, count}
    this.loaded = false;
    this._defSeq = 0;
    this._spawnSeq = 0;
  }

  FxSystem.prototype.load = function (variant) {
    var self = this;
    var names = Object.keys(HIT_MAP).reduce(function (acc, k) {
      HIT_MAP[k].forEach(function (n) { if (acc.indexOf(n) < 0) acc.push(n); });
      return acc;
    }, []).concat(Object.keys(LANE_MAP).map(function (k) { return LANE_MAP[k]; }))
      .concat(['fx_note_hold_aura', 'fx_note_critical_long_hold_gen_aura']);
    var v = variant == null ? this.variant : variant;
    this.variant = v;
    return Promise.all(names.map(function (name) {
      return fetch(self.baseUrl + v + '/' + name + '.json').then(function (r) {
        if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
        return r.json();
      }).then(function (json) {
        self.defs[name] = convertEmitter(json, 0);
      });
    })).then(function () {
      self.loaded = true;
      return self.defs;
    });
  };

  FxSystem.prototype._bucket = function (def) {
    if (!def._id) def._id = ++this._defSeq;
    var b = this.buckets[def._id];
    if (!b) {
      var cap = Math.max(16, Math.min(BUCKET_CAP, (def.maxParticles || 1) * 32));
      b = this.buckets[def._id] = {
        def: def, state: new Float32Array(cap * 12),
        size: new Float32Array(cap), alpha: new Float32Array(cap),
        cursor: 0, cap: cap
      };
    }
    return b;
  };

  FxSystem.prototype._spawnOne = function (def, ox, oy, scale, rnd, invisible) {
    var b = this._bucket(def);
    var i = b.cursor;
    b.cursor = (b.cursor + 1) % b.cap;
    var s = b.state, base = i * 12;
    var life = constOrRandom(def.startLifetime, rnd);
    if (!(life > 0)) life = 0.5;
    var sizeX = constOrRandom(def.startSizeX, rnd);
    var sizeY = constOrRandom(def.startSizeY, rnd);
    var size = Math.max(sizeX, sizeY) || 1;
    if (invisible) { size = 0; }
    var col = def.startColor || {};
    var cMin = col.colorMin || { r: 1, g: 1, b: 1, a: 1 };
    var cMax = col.colorMax || cMin;
    var cr = cMin.r + (cMax.r - cMin.r) * rnd();
    var cg = cMin.g + (cMax.g - cMin.g) * rnd();
    var cb = cMin.b + (cMax.b - cMin.b) * rnd();
    var ca = cMin.a + (cMax.a - cMin.a) * rnd();
    if (invisible) ca = 0;
    var shape = def.shape || {};
    var radius = (shape.radius || 0) * FX_UNIT_LU * scale;
    var ang = rnd() * Math.PI * 2;
    var rr = radius * Math.sqrt(rnd());
    var speed = constOrRandom(def.startSpeed, rnd) * FX_UNIT_LU * scale;
    var dirA = (shape.angle || 0) * Math.PI / 180;
    var dir = (rnd() - 0.5) * 2 * dirA;
    s[base] = ox + (def.offset.x || 0) * FX_UNIT_LU * scale + Math.cos(ang) * rr;
    s[base + 1] = oy + (def.offset.y || 0) * FX_UNIT_LU * scale + Math.sin(ang) * rr;
    s[base + 2] = Math.sin(dir) * speed;
    s[base + 3] = -Math.cos(dir) * speed;
    s[base + 4] = 0;            // age
    s[base + 5] = life;         // remaining life
    s[base + 6] = size * FX_UNIT_LU * scale; // size0 (px at life start)
    s[base + 7] = ca;           // alpha0
    s[base + 8] = constOrRandom(def.startRotationZ, rnd) * Math.PI / 180;
    s[base + 9] = 0;            // spin (rotationOverLifetime applied at render)
    s[base + 10] = def.gravityModifier || 0;
    s[base + 11] = 0;           // drag
    b.tint = b.tint || {};
    b.tint[i] = [cr, cg, cb];
    b.defRef = def;
    return i;
  };

  FxSystem.prototype.spawnTree = function (def, ox, oy, scale, rnd) {
    if (!def) return;
    var self = this;
    rnd = rnd || Math.random;
    // Root bursts at t=0; children spawn with the same origin (their own
    // transform offsets apply inside _spawnOne).
    (def.bursts || []).forEach(function (burst) {
      var count = Math.round((burst.countMin || 0) + (burst.countMax - burst.countMin || 0) * rnd());
      for (var i = 0; i < count; i++) self._spawnOne(def, ox, oy, scale, rnd);
    });
    if (!(def.bursts || []).length) {
      // Container-only emitters (life 0, no bursts): spawn one instance so
      // children still fire; the container particle itself is forced
      // invisible (size 0 / alpha 0) instead of trusting its tile.
      if (def.children.length) self._spawnOne(def, ox, oy, scale, rnd, true);
    }
    def.children.forEach(function (child) { self.spawnTree(child, ox, oy, scale, rnd); });
  };

  /** Spawn the hit effect for a note kind at stage coords (ox, oy). */
  FxSystem.prototype.hit = function (kind, ox, oy, scale, seed) {
    if (!this.loaded) return;
    var names = HIT_MAP[kind];
    if (!names) return;
    var self = this;
    var rnd = (function () {
      var s = (seed == null ? (++self._spawnSeq * 7919) : seed) >>> 0;
      return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    })();
    names.forEach(function (n) {
      var def = self.defs[n];
      if (def) self.spawnTree(def, ox, oy, scale || 1, rnd);
    });
  };

  FxSystem.prototype.laneFlash = function (kind, ox, oy, scale) {
    if (!this.loaded) return;
    var def = this.defs[LANE_MAP[kind] || LANE_MAP.normal];
    if (def) this.spawnTree(def, ox, oy, scale || 1, Math.random);
  };

  FxSystem.prototype.step = function (dt) {
    if (dt <= 0) return 0;
    var alive = 0;
    var self = this;
    Object.keys(this.buckets).forEach(function (id) {
      var b = self.buckets[id];
      var def = b.def;
      // Gravity: Unity gravityModifier * 9.81, screen y is downwards.
      var n = self.core.particleStep(b.state, b.cap, dt, 9.81 * (def.gravityModifier || 0),
        def.sizeLUT, def.alphaLUT, b.size, b.alpha);
      alive += n;
      // Velocity / force over lifetime are per-def curves the WASM step
      // does not know: apply them as extra displacement here.
      if (def.velXLUT || def.velYLUT || def.forceXLUT || def.forceYLUT) {
        for (var i = 0; i < b.cap; i++) {
          var base = i * 12;
          var life = b.state[base + 5];
          if (life <= 0) continue;
          var age = b.state[base + 4];
          var frac = Math.min(1, Math.max(0, age / Math.max(1e-6, age + life)));
          var li = Math.min(LUT_N - 2, Math.floor(frac * (LUT_N - 1)));
          var fr = frac * (LUT_N - 1) - li;
          var lut = function (arr) { return arr ? arr[li] * (1 - fr) + arr[li + 1] * fr : 0; };
          // LUTs are Unity units/sec (velocity) and units/sec^2 (force);
          // positions/velocities are px, so convert with FX_UNIT_LU.
          // All engine call sites pass scale 1, so no per-particle scale.
          b.state[base] += lut(def.velXLUT) * dt * FX_UNIT_LU;
          b.state[base + 1] += lut(def.velYLUT) * dt * FX_UNIT_LU;
          b.state[base + 2] += lut(def.forceXLUT) * dt * FX_UNIT_LU;
          b.state[base + 3] += lut(def.forceYLUT) * dt * FX_UNIT_LU;
        }
      }
    });
    return alive;
  };

  /** Emit live particles as additive quads into the renderer. */
  FxSystem.prototype.emit = function (renderer, stage) {
    var self = this;
    // Draw low `order` (lane flashes, order 1) before note FX (order 50+).
    var ids = Object.keys(this.buckets).sort(function (a, b) {
      return (self.buckets[a].def.order || 0) - (self.buckets[b].def.order || 0);
    });
    ids.forEach(function (id) {
      var b = self.buckets[id];
      var def = b.def;
      var tiles = def.tiles;
      var tileW = 1 / tiles.tilesX, tileH = 1 / tiles.tilesY;
      var col = tiles.frame % tiles.tilesX, row = Math.floor(tiles.frame / tiles.tilesX);
      var u0 = col * tileW, u1 = u0 + tileW, v0 = row * tileH, v1 = v0 + tileH;
      var order = def.order || 0;
      for (var i = 0; i < b.cap; i++) {
        var base = i * 12;
        if (b.state[base + 5] <= 0) continue;
        var a = b.alpha[i];
        if (a <= 0.004) continue;
        var x = b.state[base], y = b.state[base + 1];
        var size = b.size[i];
        if (size <= 0.5) continue;
        // Stretched-billboard emitters (renderer mode 2, e.g. lane beams)
        // are tall: sizeY dominates, lengthScale stretches along Y.
        var w = size, h = size;
        if (def.rendererMode === 2 && def.startSizeY) {
          var sy = (def.startSizeY.constant || size) * FX_UNIT_LU * stage.luScale;
          h = Math.max(h, sy * def.lengthScale);
          w = Math.max(1, (def.startSizeX ? def.startSizeX.constant : size) * FX_UNIT_LU * stage.luScale);
        }
        var rot = b.state[base + 8];
        if (def.rotLUT) {
          var age = b.state[base + 4], life = b.state[base + 5];
          var frac = Math.min(1, Math.max(0, age / Math.max(1e-6, age + life)));
          var li = Math.min(LUT_N - 2, Math.floor(frac * (LUT_N - 1)));
          rot += def.rotLUT[li] * Math.PI / 180;
        }
        var tint = (b.tint && b.tint[i]) || [1, 1, 1];
        var cg = def.colorLUT;
        var cr = tint[0], cg2 = tint[1], cb2 = tint[2];
        if (cg) {
          var age2 = b.state[base + 4], life2 = b.state[base + 5];
          var fr2 = Math.min(1, Math.max(0, age2 / Math.max(1e-6, age2 + life2)));
          var li2 = Math.min(LUT_N - 2, Math.floor(fr2 * (LUT_N - 1)));
          var f2 = fr2 * (LUT_N - 1) - li2;
          cr *= cg.r[li2] * (1 - f2) + cg.r[li2 + 1] * f2;
          cg2 *= cg.g[li2] * (1 - f2) + cg.g[li2 + 1] * f2;
          cb2 *= cg.b[li2] * (1 - f2) + cg.b[li2 + 1] * f2;
        }
        var hw = w / 2, hh = h / 2;
        var c = Math.cos(rot), s = Math.sin(rot);
        // corners: TL, TR, BR, BL (screen space, y down)
        var cs = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
        var pts = cs.map(function (p) { return [x + p[0] * c - p[1] * s, y + p[0] * s + p[1] * c]; });
        var recip = stage.recipAt ? stage.recipAt(y) : 1;
        renderer.quad('effect', pts, [u0, v0, u1, v1], [cr, cg2, cb2, a], recip, 'add', order);
      }
    });
  };

  FxSystem.prototype.clear = function () {
    var self = this;
    Object.keys(this.buckets).forEach(function (id) {
      var b = self.buckets[id];
      b.state.fill(0); b.alpha.fill(0); b.size.fill(0); b.cursor = 0;
    });
  };

  global.ProsekaFx = { FxSystem: FxSystem, HIT_MAP: HIT_MAP, LANE_MAP: LANE_MAP, FX_UNIT_LU: FX_UNIT_LU, _convertEmitter: convertEmitter };
})(typeof window !== 'undefined' ? window : globalThis);
