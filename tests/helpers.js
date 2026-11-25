'use strict';
/* Shared test helpers: load a project JS file in Node (no DOM needed). */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function loadJs(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const g = {};
  const fn = new Function('window', 'globalThis', 'self', code + '\n;return globalThis;');
  fn(g, g, g);
  return g;
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('FAIL  ' + name + (extra != null ? '  (' + extra + ')' : '')); }
}
function approx(a, b, eps, name) {
  const d = Math.abs(a - b);
  check(name + ' ≈ ' + b + ' (got ' + a + ')', d <= eps, 'diff=' + d);
}
function approxArr(a, b, eps, name) {
  if (a.length !== b.length) { check(name + ' length', false, a.length + ' vs ' + b.length); return; }
  let worst = 0, wi = -1;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > worst) { worst = d; wi = i; } }
  check(name + ' (worst diff ' + worst.toExponential(2) + ' at ' + wi + ')', worst <= eps, 'worst=' + worst);
}
function summary(label) {
  console.log(failures === 0 ? 'PASS ' + label : 'FAIL ' + label + ' (' + failures + ' failures)');
  return failures;
}
module.exports = { loadJs, check, approx, approxArr, summary, ROOT, fs, path };
