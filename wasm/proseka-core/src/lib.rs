//! proseka-core: the hot math of the rhythm-game player, in Rust/WASM.
//!
//! The JavaScript side (js/wasm-loader.js) owns all DOM/WebGL/audio work.
//! This module only crunches numbers over flat f32 arrays in linear memory,
//! so the per-frame JS work is "pick the visible slice and draw it".
//!
//! Conventions (shared with the JS fallback in js/wasm-loader.js):
//! - All floats are f32, little-endian, passed by pointer + length.
//! - `alloc`/`dealloc` use a bump allocator over a leaked Vec; the JS side
//!   allocates once per DrawData build and reuses the buffers per frame.
//! - Geometry uses the original player's constants:
//!     s = exp(-KAP * z)          (perspective scale, z=0 at the judgement line)
//!     recipW = s                  (== 1 / clip.w ; see gl-renderer.js)
//!     x = cx + sg * lp * LU * s
//!     y = yV + (yJ - yV) * s
//! - `rand_hash` reproduces the JS deterministic pseudo-random
//!   `fract(sin(i*127.1 + j*311.7) * 43758.5453)` used for hit effects,
//!   so a seek renders exactly the same particles.

use core::ptr;

// ---------------------------------------------------------------- alloc
static mut BUMP: usize = 0;
static mut BUMP_END: usize = 0;

/// Bump-allocate `size` bytes (8-byte aligned). Never freed individually;
/// call `reset_alloc` after a DrawData rebuild to reuse the arena.
#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    unsafe {
        let size = (size + 7) & !7;
        if BUMP == 0 || BUMP + size > BUMP_END {
            // Grow the arena in 1 MiB chunks.
            let grow = size.max(1 << 20);
            let mut v: Vec<u8> = Vec::with_capacity(grow);
            let p = v.as_mut_ptr() as usize;
            core::mem::forget(v);
            BUMP = p;
            BUMP_END = p + grow;
        }
        let p = BUMP as *mut u8;
        BUMP += size;
        p
    }
}

#[no_mangle]
pub extern "C" fn reset_alloc() {
    unsafe {
        BUMP = 0;
        BUMP_END = 0;
    }
}

#[no_mangle]
pub extern "C" fn version() -> u32 {
    1
}

// ---------------------------------------------------------------- helpers
#[inline]
fn read_f32(p: *const f32, i: usize) -> f32 {
    unsafe { ptr::read_unaligned(p.add(i)) }
}
#[inline]
fn write_f32(p: *mut f32, i: usize, v: f32) {
    unsafe { ptr::write_unaligned(p.add(i), v) }
}

/// Binary search: largest i with arr[i] <= x, or -1 if none. arr is sorted.
fn search_le(arr: *const f32, n: usize, x: f32) -> isize {
    if n == 0 {
        return -1;
    }
    let mut lo: isize = 0;
    let mut hi: isize = n as isize - 1;
    let mut ans: isize = -1;
    while lo <= hi {
        let mid = (lo + hi) >> 1;
        if read_f32(arr, mid as usize) <= x {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    ans
}

// ---------------------------------------------------------------- projection
/// Project (lanePos, depth) pairs to screen space.
/// in:  [lp0, z0, lp1, z1, ...]  (2*n f32)
/// out: [x0, y0, s0, recipW0, ...] (4*n f32), recipW == s.
#[no_mangle]
pub extern "C" fn pj_batch(
    inp: *const f32,
    out: *mut f32,
    n: usize,
    cx: f32,
    yv: f32,
    yj: f32,
    lu: f32,
    sg: f32,
    kap: f32,
) {
    for i in 0..n {
        let lp = read_f32(inp, i * 2);
        let z = read_f32(inp, i * 2 + 1);
        let s = libm::expf(-kap * z);
        write_f32(out, i * 4, cx + sg * lp * lu * s);
        write_f32(out, i * 4 + 1, yv + (yj - yv) * s);
        write_f32(out, i * 4 + 2, s);
        write_f32(out, i * 4 + 3, s);
    }
}

// ---------------------------------------------------------------- tempo map
/// bar -> seconds. Mirrors the original `tm()`:
///   cb(bar) = cum[m] + (bar-m)*len[m]
///   sec = bs[i] + (cb - bx[i]) * 60 / bpm[i]
/// cum: beats per bar prefix (total+2), len: beats per bar (total+2),
/// bx: beat position of each BPM change, bs: seconds at each change,
/// bpm: BPM values. `total` = number of bars (floor of last bar + 1).
#[no_mangle]
pub extern "C" fn bar_to_sec_batch(
    bars: *const f32,
    out: *mut f32,
    n: usize,
    cum: *const f32,
    len: *const f32,
    total: usize,
    bx: *const f32,
    bs: *const f32,
    bpm: *const f32,
    bpm_n: usize,
) {
    for i in 0..n {
        let bar = read_f32(bars, i);
        let mut m = libm::floorf(bar) as isize;
        if m < 0 {
            m = 0;
        }
        if m as usize > total + 1 {
            m = (total + 1) as isize;
        }
        let mu = m as usize;
        let cb = read_f32(cum, mu) + (bar - m as f32) * read_f32(len, mu);
        let seg = search_le(bx, bpm_n, cb);
        let si = if seg < 0 { 0 } else { seg as usize };
        let sec = read_f32(bs, si) + (cb - read_f32(bx, si)) * 60.0 / read_f32(bpm, si);
        write_f32(out, i, sec);
    }
}

/// seconds -> (bar, bpm). Mirrors the original `atT()`.
/// out: [bar0, bpm0, bar1, bpm1, ...] (2*n f32).
#[no_mangle]
pub extern "C" fn sec_to_bar_batch(
    secs: *const f32,
    out: *mut f32,
    n: usize,
    cum: *const f32,
    len: *const f32,
    total: usize,
    bx: *const f32,
    bs: *const f32,
    bpm: *const f32,
    bpm_n: usize,
) {
    for i in 0..n {
        let t = read_f32(secs, i).max(0.0);
        let seg = search_le(bs, bpm_n, t);
        let si = if seg < 0 { 0 } else { seg as usize };
        let x = read_f32(bx, si) + (t - read_f32(bs, si)) * read_f32(bpm, si) / 60.0;
        // find bar m with cum[m+1] <= x
        let mut m: usize = 0;
        while m < total + 1 && read_f32(cum, m + 1) <= x {
            m += 1;
        }
        let bar = m as f32 + (x - read_f32(cum, m)) / read_f32(len, m);
        write_f32(out, i * 2, bar);
        write_f32(out, i * 2 + 1, read_f32(bpm, si));
    }
}

// ---------------------------------------------------------------- scroll (visual time)
/// Scroll position S(t) = integral of the TIL speed over seconds.
/// One call per speed layer (few layers per chart).
/// T: event times (sec, sorted), V: speeds, P: accumulated S at each event.
/// out[i] = t if no event yet, else P[k] + V[k]*(t - T[k]).
#[no_mangle]
pub extern "C" fn scroll_batch(
    times: *const f32,
    out: *mut f32,
    n: usize,
    t_ev: *const f32,
    v_ev: *const f32,
    p_ev: *const f32,
    m: usize,
) {
    for i in 0..n {
        let t = read_f32(times, i);
        let k = search_le(t_ev, m, t);
        let q = if k < 0 {
            t
        } else {
            let ku = k as usize;
            read_f32(p_ev, ku) + read_f32(v_ev, ku) * (t - read_f32(t_ev, ku))
        };
        write_f32(out, i, q);
    }
}

/// Current speed multiplier at time t (the `g=1` branch of mkS).
#[no_mangle]
pub extern "C" fn scroll_speed_batch(
    times: *const f32,
    out: *mut f32,
    n: usize,
    t_ev: *const f32,
    v_ev: *const f32,
    m: usize,
) {
    for i in 0..n {
        let t = read_f32(times, i);
        let k = search_le(t_ev, m, t);
        write_f32(out, i, if k < 0 { 1.0 } else { read_f32(v_ev, k as usize) });
    }
}

// ---------------------------------------------------------------- slide easing
/// Closed-form inverse of the slide-edge easing (port of the original
/// `easeS`/`tIn`). f in [0,1]; ein/eout are 0/1 flags per sample.
/// out[i] = s(t) with s = 3t^2 - 2t^3 after solving Y(t) = f.
#[no_mangle]
pub extern "C" fn slide_ease_batch(
    f: *const f32,
    ein: *const u8,
    eout: *const u8,
    out: *mut f32,
    n: usize,
) {
    for i in 0..n {
        let fv = read_f32(f, i);
        let is_in = unsafe { *ein.add(i) } != 0;
        let is_out = unsafe { *eout.add(i) } != 0;
        let t: f32 = if !is_in && !is_out {
            fv
        } else if is_in && is_out {
            // cubic: t^3 - 3t/4 ... solved via Cardano (original formula)
            let g = fv - 0.5;
            let r = libm::sqrtf(g * g + 0.0625);
            let a = libm::cbrtf((g + r) / 2.0);
            let b = libm::cbrtf((g - r) / 2.0);
            0.5 + a + b
        } else if is_in {
            // t^3 - 3t + 2f = 0, root in [0,1]
            let v = libm::acosf(-fv) / 3.0 + 4.1887902047863905;
            2.0 * libm::cosf(v)
        } else {
            let v = libm::acosf(-(1.0 - fv)) / 3.0 + 4.1887902047863905;
            1.0 - 2.0 * libm::cosf(v)
        };
        let tc = t.clamp(0.0, 1.0);
        write_f32(out, i, tc * tc * (3.0 - 2.0 * tc));
    }
}

// ---------------------------------------------------------------- deterministic random
#[no_mangle]
pub extern "C" fn rand_hash(i: u32, j: u32) -> f32 {
    // f64 math on purpose: the JS reference uses Math.sin (f64), and hit
    // effects must render identically after a seek in either implementation.
    let x = libm::sin((i as f64) * 127.1 + (j as f64) * 311.7) * 43758.5453;
    (x - libm::floor(x)) as f32
}

// ---------------------------------------------------------------- particles
/// Particle state-of-arrays, 12 f32 per particle:
///   0 px, 1 py, 2 vx, 3 vy, 4 age, 5 life, 6 size0, 7 alpha0,
///   8 rot, 9 spin, 10 grav_mult, 11 drag
/// size_lut / alpha_lut: sampled over lifetime t in [0,1] (len entries);
/// pass null (0) to skip that curve. size/alpha are written back into
/// slots 6/7? No - size and alpha are outputs: out_size/out_alpha arrays
/// (n f32 each), pass null to skip. Returns number of alive particles.
/// Dead particles keep life <= 0 and are skipped by the renderer.
#[no_mangle]
pub extern "C" fn particle_step(
    state: *mut f32,
    n: usize,
    dt: f32,
    gravity: f32,
    size_lut: *const f32,
    size_lut_n: usize,
    alpha_lut: *const f32,
    alpha_lut_n: usize,
    out_size: *mut f32,
    out_alpha: *mut f32,
) -> u32 {
    let mut alive: u32 = 0;
    for i in 0..n {
        let base = i * 12;
        let life = read_f32(state, base + 5) - dt;
        write_f32(state, base + 5, life);
        if life <= 0.0 {
            if !out_alpha.is_null() {
                write_f32(out_alpha, i, 0.0);
            }
            continue;
        }
        alive += 1;
        let age = read_f32(state, base + 4) + dt;
        write_f32(state, base + 4, age);
        let grav_mult = read_f32(state, base + 10);
        let drag = read_f32(state, base + 11);
        let mut vx = read_f32(state, base + 2);
        let mut vy = read_f32(state, base + 3);
        vy += gravity * grav_mult * dt;
        if drag != 0.0 {
            let k = (1.0 - drag * dt).max(0.0);
            vx *= k;
            vy *= k;
        }
        write_f32(state, base + 2, vx);
        write_f32(state, base + 3, vy);
        write_f32(state, base + 0, read_f32(state, base + 0) + vx * dt);
        write_f32(state, base + 1, read_f32(state, base + 1) + vy * dt);
        let spin = read_f32(state, base + 9);
        if spin != 0.0 {
            write_f32(state, base + 8, read_f32(state, base + 8) + spin * dt);
        }
        // lifetime fraction: age / (age + life)
        let total = age + life;
        let frac = if total > 0.0 { (age / total).clamp(0.0, 1.0) } else { 1.0 };
        if !size_lut.is_null() && size_lut_n > 1 && !out_size.is_null() {
            let pos = frac * (size_lut_n as f32 - 1.0);
            let idx = libm::floorf(pos) as usize;
            let idx = idx.min(size_lut_n - 2);
            let f = pos - idx as f32;
            let s = read_f32(size_lut, idx) * (1.0 - f) + read_f32(size_lut, idx + 1) * f;
            write_f32(out_size, i, read_f32(state, base + 6) * s);
        } else if !out_size.is_null() {
            write_f32(out_size, i, read_f32(state, base + 6));
        }
        if !alpha_lut.is_null() && alpha_lut_n > 1 && !out_alpha.is_null() {
            let pos = frac * (alpha_lut_n as f32 - 1.0);
            let idx = libm::floorf(pos) as usize;
            let idx = idx.min(alpha_lut_n - 2);
            let f = pos - idx as f32;
            let a = read_f32(alpha_lut, idx) * (1.0 - f) + read_f32(alpha_lut, idx + 1) * f;
            write_f32(out_alpha, i, read_f32(state, base + 7) * a);
        } else if !out_alpha.is_null() {
            write_f32(out_alpha, i, read_f32(state, base + 7));
        }
    }
    alive
}
