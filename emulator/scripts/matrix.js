#!/usr/bin/env node
/*
 * matrix.js - build every pinned release as an emulator and check each one.
 *
 *   node scripts/matrix.js                  every release, then the working tree
 *   node scripts/matrix.js v3.0.4 v2.1.0    just these
 *
 * Ported in spirit from ok-rn's tools/matrix.js; the checks are this repo's own,
 * because the test kit targets the 3.0.5 compatibility tree and does not fit
 * older releases. Per release:
 *
 *   stage     OKEMU_VERSION=<release>: pinned commits, its patches, DEBUG off
 *   build     a CLEAN node-gyp build - stale objects from another release are
 *             exactly the lesson ok-rn's matrix learned (a swap must rebuild)
 *   press     test/press.js - presses reach the firmware; a PIN sets
 *   compat    test/compat.js - the key reports the release that was built,
 *             and reads as its compatibility row in ok-versions.json
 *
 * The daemon is stopped for the run (on Windows the loaded addon is a locked
 * DLL, and anywhere it would keep running the old build) and the WORKING TREE
 * is rebuilt at the end, whatever happened, before it is started again - a
 * matrix run must not leave the emulator on some old release.
 *
 * Results are printed, not written back: a release climbs its
 * `emulator: { linux, win32 }` ladder in its version script by hand, as in
 * ok-rn, because a rung is a thing somebody watched happen.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const versions = require('./versions');

const EMU = path.resolve(__dirname, '..');
const WIN = process.platform === 'win32';
/* Per-release build logs (gitignored). */
const LOGS = path.join(EMU, '.matrix');

function run(cmd, env = {}, timeoutMs = 20 * 60 * 1000) {
  const r = spawnSync(cmd, {
    cwd: EMU, shell: true, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 1 << 28,
  });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function pm2(action) {
  try {
    execSync(`pm2 ${action} onlykey-emulator`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

/* The one line a check prints about itself - PASS / FAIL - or the last error. */
function verdict(out) {
  const line = out.split(/\r?\n/).find((l) => /^(PASS|FAIL)\b/.test(l));
  if (line) return line;
  const err = out.split(/\r?\n/).filter((l) => /error|Error|WARNING/.test(l)).slice(-1)[0];
  return err ? `ERROR ${err.trim()}` : 'no verdict';
}

function buildAndCheck(version) {
  const env = version === versions.WORKING_TREE ? {} : { OKEMU_VERSION: version };
  const row = { version, stage: '-', build: '-', press: '-', compat: '-', note: '' };

  fs.rmSync(path.join(EMU, 'build'), { recursive: true, force: true });
  const b = run('npm run rebuild', env);
  /*
   * The whole build log is kept, one file per release: a failed build's
   * last line is only "gyp ERR! ... MSBuild.exe failed", and the first sweep
   * on Windows lost v3.0.4's actual compiler error that way.
   */
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(path.join(LOGS, `${version}.build.log`), b.out);
  const staged = /^stage: (v|working)/m.test(b.out) && !/a patch did not apply/.test(b.out);
  row.stage = staged ? 'ok' : 'FAIL';
  row.build = b.ok ? 'ok' : 'FAIL';
  if (!b.ok) {
    /* The first compiler or linker error says more than gyp's summary. */
    const first = b.out.split(/\r?\n/).find((l) =>
      /\berror\b[: ]|undefined (reference|symbol)|unresolved external/i.test(l) &&
      !/gyp ERR!/.test(l));
    row.note = (first ? first.trim() : verdict(b.out)).slice(0, 160) +
      ` (log: .matrix/${version}.build.log)`;
    return row;
  }
  const p = run('node test/press.js', {}, 120000);
  row.press = /^PASS/m.test(p.out) ? 'PASS' : 'FAIL';
  const c = run('node test/compat.js', {}, 120000);
  row.compat = /^PASS/m.test(c.out) ? 'PASS' : 'FAIL';
  if (row.press !== 'PASS') row.note = verdict(p.out).slice(0, 120);
  else if (row.compat !== 'PASS') row.note = verdict(c.out).slice(0, 120);
  return row;
}

function main() {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const list = asked.length ? asked : versions.list();
  for (const v of list) versions.load(v);   // fail on a typo before stopping anything

  const wasRunning = pm2('stop');
  if (wasRunning) console.log('matrix: stopped the pm2 emulator for the run');

  const rows = [];
  try {
    for (const v of list) {
      console.log(`matrix: ${v} ...`);
      const r = buildAndCheck(v);
      rows.push(r);
      console.log(`  stage ${r.stage}  build ${r.build}  press ${r.press}  compat ${r.compat}` +
        (r.note ? `  - ${r.note}` : ''));
    }
  } finally {
    console.log('matrix: restoring the working tree build');
    const back = buildAndCheck(versions.WORKING_TREE);
    rows.push({ ...back, version: `${versions.WORKING_TREE} (restored)` });
    if (wasRunning) pm2('start');
  }

  const plat = versions.EMULATOR_PLATFORM;
  console.log(`\nmatrix (${plat}${WIN ? '' : `, ${process.arch}`}):`);
  console.log('  version                   stage build press compat');
  for (const r of rows) {
    console.log(`  ${r.version.padEnd(25)} ${r.stage.padEnd(5)} ${r.build.padEnd(5)} ` +
      `${r.press.padEnd(5)} ${r.compat}`);
  }
  if (rows.some((r) => r.build !== 'ok' || r.press !== 'PASS' || r.compat !== 'PASS')) {
    process.exitCode = 1;
  }
}

main();
