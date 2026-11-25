#!/usr/bin/env node
'use strict';
/* Run every test file; exit 1 if any fails. */
const { spawnSync } = require('child_process');
const path = require('path');
const files = ['test_kernel.js', 'test_drawdata.js', 'test_fx.js', 'test_atlas.js'];
let failed = false;
for (const f of files) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed = true; console.log('>>> ' + f + ' FAILED'); }
}
process.exit(failed ? 1 : 0);
