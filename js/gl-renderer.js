/* GLRenderer: WebGL2 batched textured-quad renderer for the game view.
 *
 * One shader program, one draw call per (blend, texture) bucket per frame:
 *   normal: stage -> overlay -> guide -> band -> solid -> notes
 *   additive: effect -> solid (hit FX, hold beams, frame glow)
 * Every quad carries its own reciprocalW per vertex (aRecipW = s, the
 * perspective scale exp(-KAP*z) at that corner). The vertex shader puts
 * 1/aRecipW into gl_Position.w, so the GPU interpolates UVs with true
 * perspective correction: a note trapezoid keeps its texture undistorted
 * even when its far edge is much narrower than its near edge.
 *   gl_Position = vec4(aPos * w, 0, w),  w = 1/aRecipW
 *   varying vUv is then interpolated perspective-correctly by hardware.
 * Positions are emitted in canvas CSS pixels and converted to NDC here.
 * The stage is letterboxed to the original 1920x1342 aspect inside the
 * canvas; everything is scissored to the stage rect.
 */
(function (global) {
  'use strict';

  var VERT_SRC = [
    'attribute vec2 aPos;',
    'attribute vec2 aUv;',
    'attribute float aRecipW;',
    'attribute vec4 aTint;',
    'varying vec2 vUv;',
    'varying vec4 vTint;',
    'void main(){',
    '  float w = 1.0 / max(aRecipW, 0.02);',
    '  vUv = aUv;',
    '  vTint = aTint;',
    '  gl_Position = vec4(aPos * w, 0.0, w);',
    '}'
  ].join('\n');
  var FRAG_SRC = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform float uUseTex;',
    'uniform float uBrightness;',
    'varying vec2 vUv;',
    'varying vec4 vTint;',
    'void main(){',
    '  vec4 tex = uUseTex > 0.5 ? texture2D(uTex, vUv) : vec4(1.0);',
    '  float a = tex.a * vTint.a;',
    '  if (a < 0.003) discard;',
    '  gl_FragColor = vec4(tex.rgb * vTint.rgb * uBrightness, a);',
    '}'
  ].join('\n');

  var FLOATS_PER_VERTEX = 9; // x, y, u, v, recipW, r, g, b, a
  var FLOATS_PER_QUAD = FLOATS_PER_VERTEX * 6;
  // Fixed bucket draw order (painter's algorithm, no depth test).
  // 'bg' is the background overlay behind the stage; 'overlay' is the
  // same image drawn over the stage with the cover opacity.
  var BUCKET_ORDER = ['bg', 'stage', 'overlay', 'guide', 'bandBase', 'band', 'solid', 'notes', 'effect', 'glow'];
  var BUCKET_BLEND = { bg: 'normal', stage: 'normal', overlay: 'normal', guide: 'normal', bandBase: 'normal', band: 'normal', solid: 'normal', notes: 'normal', effect: 'add', glow: 'add' };
  var BUCKET_TEX = { bg: 'overlay', stage: 'stage', overlay: 'overlay', guide: 'guide', bandBase: null, band: 'band', solid: null, notes: 'notes', effect: 'effect', glow: null };

  function GLRenderer(canvas) {
    this.canvas = canvas;
    this.supported = false;
    this.gl = null;
    this.textures = {};   // id -> WebGLTexture
    this.atlases = {};    // id -> atlas json
    this.buckets = {};
    this.stats = { quads: 0, drawCalls: 0, uploadBytes: 0 };
    this.geom = null;
    this._init();
  }

  GLRenderer.prototype._init = function () {
    var gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: true, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false
    });
    if (!gl) return;
    this.gl = gl;
    var vs = this._shader(gl.VERTEX_SHADER, VERT_SRC);
    var fs = this._shader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    this.prog = prog;
    this.uTex = gl.getUniformLocation(prog, 'uTex');
    this.uUseTex = gl.getUniformLocation(prog, 'uUseTex');
    this.uBrightness = gl.getUniformLocation(prog, 'uBrightness');
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    var stride = FLOATS_PER_VERTEX * 4;
    var loc = function (name, size, offset) {
      var l = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, offset * 4);
    };
    loc('aPos', 2, 0); loc('aUv', 2, 2); loc('aRecipW', 1, 4); loc('aTint', 4, 5);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.SCISSOR_TEST);
    this.supported = true;
    for (var i = 0; i < BUCKET_ORDER.length; i++) {
      this.buckets[BUCKET_ORDER[i]] = { data: new Float32Array(FLOATS_PER_QUAD * 256), count: 0 };
    }
  };

  GLRenderer.prototype._shader = function (type, src) {
    var gl = this.gl;
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      if (typeof console !== 'undefined') console.error('[gl] shader:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };

  /* Stage geometry: same constants as the original Canvas2D player.
   * GAR 1920/1342, vanishing point yV = 5.74% of stage height,
   * judgement line yJ = 73.47%, lane width LU = 6.58% of stage width. */
  GLRenderer.prototype.resize = function (cssW, cssH, dpr) {
    var gl = this.gl;
    if (!gl || cssW < 2 || cssH < 2) return null;
    var W = Math.max(1, Math.round(cssW * dpr));
    var H = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    var GAR = 1920 / 1342;
    var wide = cssW / cssH >= GAR;
    var Sw = wide ? cssH * GAR : cssW;
    var Sh = Sw / GAR;
    var ox = (cssW - Sw) / 2, oy = (cssH - Sh) / 2;
    var geom = {
      W: cssW, H: cssH, dpr: dpr, Sw: Sw, Sh: Sh, ox: ox, oy: oy,
      cx: cssW / 2, yV: oy + 0.0574 * Sh, yJ: oy + 0.7347 * Sh,
      LU: 0.0658 * Sw, k0: Sw / 1136, yB: oy + Sh,
      scissor: [Math.round(ox * dpr), Math.round((cssH - oy - Sh) * dpr), Math.round(Sw * dpr), Math.round(Sh * dpr)]
    };
    geom.px = function (x, y) { return [2 * x / cssW - 1, 1 - 2 * y / cssH]; };
    this.geom = geom;
    return geom;
  };

  GLRenderer.prototype.loadTexture = function (id, img) {
    var gl = this.gl;
    if (!gl) return null;
    if (this.textures[id]) { gl.deleteTexture(this.textures[id]); delete this.textures[id]; }
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures[id] = tex;
    return tex;
  };

  GLRenderer.prototype.setAtlas = function (id, json) { this.atlases[id] = json; };
  GLRenderer.prototype.spriteUV = function (atlasId, name) {
    var a = this.atlases[atlasId];
    if (!a || !a.sprites[name]) return null;
    var s = a.sprites[name];
    // Atlas JSON uses image coords (y down); quad() takes the same, and
    // textures are uploaded with UNPACK_FLIP_Y_WEBGL=false, so GL v is
    // the image fraction from the top. No 1-v flip anywhere.
    return [s.u0, s.v0, s.u1, s.v1, s.w, s.h];
  };

  GLRenderer.prototype.beginFrame = function (brightness) {
    var gl = this.gl;
    this.brightness = brightness == null ? 1 : brightness;
    this.stats.quads = 0; this.stats.drawCalls = 0; this.stats.uploadBytes = 0;
    for (var i = 0; i < BUCKET_ORDER.length; i++) this.buckets[BUCKET_ORDER[i]].count = 0;
    gl.clearColor(0.02, 0.03, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    var sc = this.geom.scissor;
    gl.scissor(sc[0], sc[1], sc[2], sc[3]);
  };

  function ensure(bucket, quads) {
    var need = (bucket.count + quads) * FLOATS_PER_QUAD;
    if (need > bucket.data.length) {
      var next = new Float32Array(Math.max(need, bucket.data.length * 2));
      next.set(bucket.data);
      bucket.data = next;
    }
  }

  /* pts: [[x,y] x4] TL,TR,BR,BL in canvas CSS px.
   * uv: [u0,v0,u1,v1] in image coords (y down) or null for solid.
   * tint: [r,g,b,a] (0..1), or [[r,g,b,a] x4] for per-corner tints
   *   (corners TL,TR,BR,BL - used for guide gradients and beams).
   * recipW: number or [w0,w1,w2,w3]. */
  GLRenderer.prototype.quad = function (bucket, pts, uv, tint, recipW, order) {
    var b = this.buckets[bucket];
    if (!b || !this.geom) return;
    ensure(b, 1);
    var g = this.geom, W = g.W, H = g.H;
    var d = b.data, o = b.count * FLOATS_PER_QUAD;
    // UV corners, image coords (y down): TL(u0,v0), TR(u1,v0), BR(u1,v1), BL(u0,v1).
    var u0 = 0, vTop = 0, u1 = 0, vBot = 0;
    if (uv) { u0 = uv[0]; u1 = uv[2]; vTop = uv[1]; vBot = uv[3]; }
    var corners = [
      [pts[0], u0, vTop, 0], [pts[1], u1, vTop, 1], [pts[2], u1, vBot, 2],
      [pts[0], u0, vTop, 0], [pts[2], u1, vBot, 2], [pts[3], u0, vBot, 3]
    ];
    var perCorner = tint && tint.length === 4 && Array.isArray(tint[0]);
    for (var i = 0; i < 6; i++) {
      var c = corners[i];
      var p = c[0];
      var w = (recipW == null) ? 1 : (typeof recipW === 'number' ? recipW : recipW[c[3]]);
      var tc = perCorner ? tint[c[3]] : tint;
      d[o++] = 2 * p[0] / W - 1;
      d[o++] = 1 - 2 * p[1] / H;
      d[o++] = c[1]; d[o++] = c[2];
      d[o++] = w;
      d[o++] = tc[0]; d[o++] = tc[1]; d[o++] = tc[2]; d[o++] = tc[3];
    }
    b.count++;
    this.stats.quads++;
  };

  GLRenderer.prototype.quadRect = function (bucket, x, y, w, h, uv, tint, recipW) {
    this.quad(bucket,
      [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
      uv, tint, recipW);
  };

  GLRenderer.prototype.endFrame = function () {
    var gl = this.gl;
    if (!gl) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    for (var bi = 0; bi < BUCKET_ORDER.length; bi++) {
      var name = BUCKET_ORDER[bi];
      var b = this.buckets[name];
      if (!b.count) continue;
      var texId = BUCKET_TEX[name];
      var tex = texId ? this.textures[texId] : null;
      gl.activeTexture(gl.TEXTURE0);
      if (tex) gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.uTex, 0);
      gl.uniform1f(this.uUseTex, tex ? 1 : 0);
      gl.uniform1f(this.uBrightness, (name === 'bg' || name === 'stage' || name === 'overlay') ? this.brightness : 1);
      if (BUCKET_BLEND[name] === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.BLEND);
      var bytes = b.count * FLOATS_PER_QUAD * 4;
      gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.count * FLOATS_PER_QUAD), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, b.count * 6);
      this.stats.drawCalls++;
      this.stats.uploadBytes += bytes;
    }
    gl.disable(gl.BLEND);
  };

  global.ProsekaGL = { GLRenderer: GLRenderer };
})(typeof window !== 'undefined' ? window : globalThis);
