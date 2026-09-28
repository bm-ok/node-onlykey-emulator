#!/usr/bin/env node
/*
 * compat.js - does the BUILT key answer as its release's compatibility row says?
 *
 *   node test/compat.js [storageDir]
 *
 * The version matrix builds one release at a time (OKEMU_VERSION); stage.js
 * records which in .stage/build.json. This runs a fresh in-process device,
 * sends OKCONNECT, and reads back the status the firmware itself reports -
 * then:
 *
 *   1. the reported version is the release that was built, as the variant
 *      that was built ('-prod' with DEBUG off, '-test' with it on) - so a
 *      stage that quietly built the wrong tree, or the wrong side of the DEBUG
 *      gate, fails here rather than in whatever a GUI later assumes;
 *   2. for a production build, node-onlykey-lib's capabilities() of that LIVE
 *      reply equal the release's `compatibility` row in node-onlykey-lib/versions, flag
 *      by flag - which is how ok-rn and every GUI decide what a key can do.
 *
 * A DEBUG build of a release is not compared against the row: the lib reads
 * '-test' as the development tree, so it would legitimately claim more than the
 * signed release (that is why releases stage with DEBUG off). The working tree
 * is the newest tree and is checked against the table's newest row (v3.1.0 now).
 *
 * Same teardown note as test/press.js: exits without emu.stop().
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const emu = require('..');
const versions = require('../scripts/versions');
const libVersion = require('node-onlykey-lib/device/version');
const libVersions = require('node-onlykey-lib/versions');

/** Flatten nested objects to dotted keys, so a diff names the exact flag. */
function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
}

const OKCONNECT = 0xE4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const build = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.stage', 'build.json'), 'utf8'));
/*
 * The working tree is the NEWEST tree, so its row is the newest release in the
 * library's table - list()[0]. This was hard-wired to 'v3.0.5', and the day the
 * checkouts moved to 3.1.0 (2026-09-28: bm-ok masters = release-3.1.0 + the
 * CTAPHID wipe fix) a key reporting v3.1.0 failed against the 3.0.5 row. Taking
 * it from the table follows each release without an edit here.
 */
const rowName = build.version === versions.WORKING_TREE ? libVersions.list()[0] : build.version;
/* The row travels with the library's pin: the same commit's capabilities()
 * generated it (node-onlykey-lib scripts/versions-compat.js). */
const row = { compatibility: libVersions.compatibilityOf(rowName) };

const storageDir = process.argv[2] ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'okemu-compat-'));

const replies = [];
emu.on('hid', (buf) => {
  const text = buf.toString('latin1').replace(/\0.*$/s, '').trim();
  if (text) replies.push(text);
});

function fail(msg) {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
}

(async () => {
  console.log(`built: ${build.version} (DEBUG ${build.debug ? 'on' : 'off'}); row: ${rowName}`);
  if (!row || !row.compatibility) fail(`no compatibility row for ${rowName} in node-onlykey-lib/versions`);

  emu.start({ storageDir });
  await sleep(3000);

  const b = Buffer.alloc(64);
  b.writeUInt32BE(0xFFFFFFFF, 0);
  b[4] = OKCONNECT;
  emu.writeHid(b, emu.IFACE.VENDOR);
  await sleep(1500);

  /* The status reply is the one that parses as a version; skip anything else. */
  const reply = replies.map((r) => r.replace(/^\xff+/, ''))
    .find((r) => libVersion.parseStatus(r).release);
  if (!reply) fail(`no status reply to OKCONNECT; saw ${JSON.stringify(replies)}`);
  const info = libVersion.parseStatus(reply);
  console.log(`key reports: ${JSON.stringify(reply)} (state ${info.state}, build ${info.build})`);

  /* 1. the release and the variant that were built */
  const want = rowName.replace(/^v/, '');
  const got = info.version || '';
  if (!got.replace(/^v/, '').startsWith(want)) {
    fail(`the key says ${got}, but ${rowName} was built`);
  }
  const wantBuild = build.debug ? 'debug' : 'production';
  if (/^\d+\.\d+\.\d+$/.test(want) && info.build !== wantBuild) {
    fail(`the key reports a ${info.build} build, but DEBUG was ${build.debug ? 'on' : 'off'}`);
  }

  /* 2. the lib's reading of the live reply against the recorded row */
  if (build.debug) {
    console.log('PASS: the key reports the release and variant that were built ' +
      '(DEBUG build - not compared against the signed row)');
    process.exit(0);
  }
  const live = flat(libVersion.capabilities(reply, { unreleased: row.compatibility.unreleased }));
  const recorded = flat(row.compatibility.capabilities);
  const keys = new Set([...Object.keys(live), ...Object.keys(recorded)]);
  const diffs = [...keys].filter((k) => JSON.stringify(live[k]) !== JSON.stringify(recorded[k]));
  if (diffs.length) {
    for (const k of diffs) {
      console.log(`  ${k}: row says ${JSON.stringify(recorded[k])}, the key reads as ${JSON.stringify(live[k])}`);
    }
    fail(`${diffs.length} capability flag(s) differ from ${rowName}'s compatibility row`);
  }
  console.log(`PASS: the key reads as ${rowName}'s compatibility row (${keys.size} flags)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
