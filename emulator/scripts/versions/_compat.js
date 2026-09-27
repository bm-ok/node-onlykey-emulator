#!/usr/bin/env node
/*
 * compat.js - what each release is COMPATIBLE with, recorded beside its pins.
 *
 *   node scripts/versions/_compat.js --write   fill every row's `compatibility`
 *   node scripts/versions/_compat.js --check   recompute; list what drifted
 *   node scripts/versions/_compat.js           the same as --check
 *
 * WHY THIS EXISTS. ok-rn manages compatibility BY KEY: node-onlykey-lib's
 * capabilities(status) turns the version string a key reports into what that
 * key supports - its gesture bands, postQuantum, backupDigest, xwingDerive and
 * the rest - and every GUI and test gates on the answer (ok-rn's e2e:
 * `if (!caps.postQuantum) skip(...)`). The test kit targets the 3.0.5
 * compatibility tree and does not fit older releases, so for the version
 * matrix the expected answer per release has to live with the release: here,
 * under its pin in the emulator's own ok-versions.json.
 *
 * It is GENERATED from the lib, never hand-typed - 29 flags times ten rows is a
 * table nobody keeps right by hand. --check catches the two drifting apart (a
 * lib change that reclassifies a release, or a pin edited without re-writing).
 * Checking it against a BUILT key - the emulated release's own OKCONNECT
 * status, read back through the lib - is the matrix's job.
 *
 * The status used is the one a SIGNED build of the release reports: model
 * Classic ('c'), production ('-prod' on the x.y.z line; the beta line has no
 * build suffix). A DEBUG build reports '-test', which the lib reads as the
 * development tree - that is why stage.js builds releases with DEBUG off.
 * The row with no pins (v3.0.5) is the compatibility feature tree - the
 * working tree - and is recorded as an unreleased production build.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const versions = require('.');

/* The lib's version module by file, for the same reason lib/press-modes.js
 * loads press.js by file: its ./device subpath pulls in @noble. */
const libVersion = require(path.join(
  path.dirname(require.resolve('node-onlykey-lib')), 'device', 'version.js'));

/** The OKCONNECT status a signed Classic build of `version` reports. */
function signedStatus(version) {
  const suffix = /^v\d+\.\d+\.\d+$/.test(version) ? '-prod' : '';
  return `UNLOCKED${version}${suffix}c`;
}

function compatibilityFor(version, pins) {
  const unreleased = !pins || !pins.libraries;
  const status = signedStatus(version);
  return {
    status,
    unreleased,
    capabilities: libVersion.capabilities(status, { unreleased }),
  };
}

/** Flatten nested objects to dotted keys, so a diff names the exact flag. */
function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const table = JSON.parse(fs.readFileSync(versions.PIN_FILE, 'utf8'));
  let drifted = 0;

  for (const [version, row] of Object.entries(table)) {
    const want = compatibilityFor(version, row);
    if (mode === 'write') {
      row.compatibility = want;
      continue;
    }
    const have = row.compatibility;
    if (!have) {
      console.log(`${version}: no compatibility recorded - run with --write`);
      drifted++;
      continue;
    }
    const a = flat(have), b = flat(want);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs = [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (diffs.length) {
      drifted++;
      console.log(`${version}: ${diffs.length} flag(s) differ from the lib`);
      for (const k of diffs) {
        console.log(`  ${k}: recorded ${JSON.stringify(a[k])}, lib says ${JSON.stringify(b[k])}`);
      }
    }
  }

  if (mode === 'write') {
    fs.writeFileSync(versions.PIN_FILE, JSON.stringify(table, null, 2) + '\n');
    console.log(`compat: wrote compatibility for ${Object.keys(table).length} ` +
      `versions to ${path.basename(versions.PIN_FILE)}`);
    return;
  }
  if (drifted) {
    console.log(`compat: ${drifted} version(s) out of step with node-onlykey-lib`);
    process.exitCode = 1;
  } else {
    console.log(`compat: all ${Object.keys(table).length} versions match node-onlykey-lib`);
  }
}

if (require.main === module) main();

module.exports = { compatibilityFor, signedStatus, flat };
