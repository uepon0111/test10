/* ProsekaWasm: Rust/WASM core (wasm/proseka_core.wasm) with a pure-JS
 * fallback that implements the exact same kernels.
 *
 * The WASM module only crunches numbers over flat f32 arrays; every
 * method here takes Float32Arrays and returns them, so callers never see
 * pointers. When WebAssembly (or the fetch of the .wasm file, e.g. on
 * file://) is unavailable, the JS kernels run instead and the player
 * keeps working, only slower. `core.isWasm` tells the HUD which path
 * is active. All kernels are verified against each other in tests/wasm.test.js.
 */
(function (global) {
  'use strict';

  var KAP = 45 * Math.log(1.06);

  /* ---------------- JS fallback kernels (reference implementation) ----- */
  function searchLe(arr, x) {
    var lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (arr[m] <= x) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  }

  var JS = {
    isWasm: false,
    version: function () { return 1; },
    pjBatch: function (inp, out, n, cx, yv, yj, lu, sg, kap) {
      for (var i = 0; i < n; i++) {
        var lp = inp[i * 2], z = inp[i * 2 + 1];
        var s = Math.exp(-kap * z);
        out[i * 4] = cx + sg * lp * lu * s;
        out[i * 4 + 1] = yv + (yj - yv) * s;
        out[i * 4 + 2] = s;
        out[i * 4 + 3] = s; // recipW == s
      }
    },
    barToSecBatch: function (bars, out, n, cum, len, total, bx, bs, bpm) {
      for (var i = 0; i < n; i++) {
        var bar = bars[i];
        var m = Math.floor(bar);
        if (m < 0) m = 0;
        if (m > total + 1) m = total + 1;
        var cb = cum[m] + (bar - m) * len[m];
        var seg = searchLe(bx, cb);
        var si = seg < 0 ? 0 : seg;
        out[i] = bs[si] + (cb - bx[si]) * 60 / bpm[si];
      }
    },
    secToBarBatch: function (secs, out, n, cum, len, total, bx, bs, bpm) {
      for (var i = 0; i < n; i++) {
        var t = Math.max(0, secs[i]);
        var seg = searchLe(bs, t);
        var si = seg < 0 ? 0 : seg;
        var x = bx[si] + (t - bs[si]) * bpm[si] / 60;
        var m = 0;
        while (m < total + 1 && cum[m + 1] <= x) m++;
        out[i * 2] = m + (x - cum[m]) / len[m];
        out[i * 2 + 1] = bpm[si];
      }
    },
    scrollBatch: function (times, out, n, tev, vev, pev) {
      for (var i = 0; i < n; i++) {
        var t = times[i];
        var k = searchLe(tev, t);
        out[i] = k < 0 ? t : pev[k] + vev[k] * (t - tev[k]);
      }
    },
    scrollSpeedBatch: function (times, out, n, tev, vev) {
      for (var i = 0; i < n; i++) {
        var k = searchLe(tev, times[i]);
        out[i] = k < 0 ? 1 : vev[k];
      }
    },
    slideEaseBatch: function (f, ein, eout, out, n) {
      for (var i = 0; i < n; i++) {
        var fv = f[i], a = ein[i], b = eout[i], t;
        if (!a && !b) t = fv;
        else if (a && b) {
          var g = fv - 0.5, r = Math.sqrt(g * g + 0.0625);
          t = 0.5 + Math.cbrt((g + r) / 2) + Math.cbrt((g - r) / 2);
        } else if (a) t = 2 * Math.cos(Math.acos(-fv) / 3 + 4.1887902047863905);
        else t = 1 - 2 * Math.cos(Math.acos(-(1 - fv)) / 3 + 4.1887902047863905);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        out[i] = t * t * (3 - 2 * t);
      }
    },
    randHash: function (i, j) {
      var x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
      return x - Math.floor(x);
    },
    particleStep: function (state, n, dt, gravity, sizeLut, alphaLut, outSize, outAlpha) {
      var alive = 0;
      var lut = function (arr, frac) {
        if (!arr || arr.length < 2) return 1;
        var pos = frac * (arr.length - 1);
        var idx = Math.floor(pos);
        if (idx > arr.length - 2) idx = arr.length - 2;
        var fr = pos - idx;
        return arr[idx] * (1 - fr) + arr[idx + 1] * fr;
      };
      for (var i = 0; i < n; i++) {
        var b = i * 12;
        var life = state[b + 5] - dt;
        state[b + 5] = life;
        if (life <= 0) { if (outAlpha) outAlpha[i] = 0; continue; }
        alive++;
        var age = state[b + 4] + dt;
        state[b + 4] = age;
        var vy = state[b + 3] + gravity * state[b + 10] * dt;
        var vx = state[b + 2];
        var drag = state[b + 11];
        if (drag !== 0) { var k = Math.max(0, 1 - drag * dt); vx *= k; vy *= k; }
        state[b + 2] = vx; state[b + 3] = vy;
        state[b] += vx * dt; state[b + 1] += vy * dt;
        if (state[b + 9] !== 0) state[b + 8] += state[b + 9] * dt;
        var total = age + life;
        var frac = total > 0 ? Math.min(1, Math.max(0, age / total)) : 1;
        if (outSize) outSize[i] = state[b + 6] * lut(sizeLut, frac);
        if (outAlpha) outAlpha[i] = state[b + 7] * lut(alphaLut, frac);
      }
      return alive;
    }
  };

  /* ---------------- WASM wrapper --------------------------------------- */
  function wrapWasm(exports) {
    var mem = exports.memory;
    var scratchPtr = exports.alloc(1 << 20); // 1 MiB scratch arena
    function f32(ptr, n) { return new Float32Array(mem.buffer, ptr, n); }
    function u8(ptr, n) { return new Uint8Array(mem.buffer, ptr, n); }
    // The bump allocator never reuses `scratchPtr` (it only grows forward),
    // so the scratch region stays valid for the module's lifetime.
    function copyIn(arr, offset) {
      f32(scratchPtr + offset, arr.length).set(arr);
      return scratchPtr + offset;
    }
    return {
      isWasm: true,
      version: function () { return exports.version(); },
      pjBatch: function (inp, out, n, cx, yv, yj, lu, sg, kap) {
        var ip = copyIn(inp, 0);
        var op = scratchPtr + 65536;
        exports.pj_batch(ip, op, n, cx, yv, yj, lu, sg, kap === undefined ? KAP : kap);
        out.set(f32(op, n * 4));
      },
      barToSecBatch: function (bars, out, n, cum, len, total, bx, bs, bpm) {
        var p = 0;
        var bp = copyIn(bars, p); p += bars.length * 4;
        var cp = copyIn(cum, p); p += cum.length * 4;
        var lp = copyIn(len, p); p += len.length * 4;
        var xp = copyIn(bx, p); p += bx.length * 4;
        var sp = copyIn(bs, p); p += bs.length * 4;
        var vp = copyIn(bpm, p); p += bpm.length * 4;
        var op = scratchPtr + 524288;
        exports.bar_to_sec_batch(bp, op, n, cp, lp, total, xp, sp, vp, bx.length);
        out.set(f32(op, n));
      },
      secToBarBatch: function (secs, out, n, cum, len, total, bx, bs, bpm) {
        var p = 0;
        var tp = copyIn(secs, p); p += secs.length * 4;
        var cp = copyIn(cum, p); p += cum.length * 4;
        var lp = copyIn(len, p); p += len.length * 4;
        var xp = copyIn(bx, p); p += bx.length * 4;
        var sp = copyIn(bs, p); p += bs.length * 4;
        var vp = copyIn(bpm, p); p += bpm.length * 4;
        var op = scratchPtr + 524288;
        exports.sec_to_bar_batch(tp, op, n, cp, lp, total, xp, sp, vp, bx.length);
        out.set(f32(op, n * 2));
      },
      scrollBatch: function (times, out, n, tev, vev, pev) {
        var p = 0;
        var tp = copyIn(times, p); p += times.length * 4;
        var ep = copyIn(tev, p); p += tev.length * 4;
        var vp = copyIn(vev, p); p += vev.length * 4;
        var pp = copyIn(pev, p); p += pev.length * 4;
        var op = scratchPtr + 524288;
        exports.scroll_batch(tp, op, n, ep, vp, pp, tev.length);
        out.set(f32(op, n));
      },
      scrollSpeedBatch: function (times, out, n, tev, vev) {
        var p = 0;
        var tp = copyIn(times, p); p += times.length * 4;
        var ep = copyIn(tev, p); p += tev.length * 4;
        var vp = copyIn(vev, p); p += vev.length * 4;
        var op = scratchPtr + 524288;
        exports.scroll_speed_batch(tp, op, n, ep, vp, tev.length);
        out.set(f32(op, n));
      },
      slideEaseBatch: function (f, ein, eout, out, n) {
        var p = 0;
        var fp = copyIn(f, p); p += f.length * 4;
        var ap = scratchPtr + p; u8(ap, ein.length).set(ein); p += ein.length;
        var bp = scratchPtr + p; u8(bp, eout.length).set(eout); p += eout.length;
        var op = scratchPtr + 524288;
        exports.slide_ease_batch(fp, ap, bp, op, n);
        out.set(f32(op, n));
      },
      randHash: function (i, j) { return exports.rand_hash(i, j); },
      particleStep: function (state, n, dt, gravity, sizeLut, alphaLut, outSize, outAlpha) {
        var p = 0;
        var sp = copyIn(state, p); p += state.length * 4;
        var slp = 0, alp = 0;
        if (sizeLut && sizeLut.length > 1) { slp = copyIn(sizeLut, p); p += sizeLut.length * 4; }
        if (alphaLut && alphaLut.length > 1) { alp = copyIn(alphaLut, p); p += alphaLut.length * 4; }
        var sop = scratchPtr + 524288, aop = scratchPtr + 524288 + 65536;
        var alive = exports.particle_step(sp, n, dt, gravity, slp, sizeLut ? sizeLut.length : 0,
          alp, alphaLut ? alphaLut.length : 0, sop, aop);
        state.set(f32(sp, state.length));
        if (outSize) outSize.set(f32(sop, n));
        if (outAlpha) outAlpha.set(f32(aop, n));
        return alive;
      }
    };
  }

  function load(url) {
    if (typeof WebAssembly === 'undefined' || !url) return Promise.resolve(JS);
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) { return WebAssembly.instantiate(buf, {}); })
      .then(function (res) { return wrapWasm(res.instance.exports); })
      .catch(function (e) {
        if (typeof console !== 'undefined') console.warn('[proseka] WASM unavailable, JS fallback:', e && e.message);
        return JS;
      });
  }

  global.ProsekaWasm = { load: load, js: JS, KAP: KAP };
})(typeof window !== 'undefined' ? window : globalThis);
