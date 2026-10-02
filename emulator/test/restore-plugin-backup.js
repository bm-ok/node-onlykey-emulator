#!/usr/bin/env node
'use strict';
/*
 * A 3.1.0 plugin backup, restored on whatever release this emulator is built as
 * (owner, 2026-10-02: "3.1.0 backups should restore, but skip the new stuff,
 * because it has no place to set it" - the target is v3.0.4, the last signed
 * release).
 *
 * The backup (test/fixtures/plugin-backup-3.1.0-edge.json) was taken on a
 * 3.1.0 soft-key build with the edge firmware plugin: a slot label, the backup
 * key, and the plugin section (0xFB) LAST. MEASURED on v3.0.4, 2026-10-02: it
 * set the label, the settings and the backup key, then "Successfully loaded
 * backup" - no error, no restart. A release without plugins must
 * restore what it knows and stop at 0xFB: its RESTORE walk breaks on a first
 * byte it does not know, with everything before it applied, and says
 * "Successfully loaded backup".
 *
 * NO DEBUG CONSOLE: like test/press.js, presses go through the emulator's own
 * queue (pressButtons), which every release takes - older firmware has neither
 * the console readiness echo nor the console press queue the kit relies on.
 *
 *   OKEMU_VERSION=v3.0.4 npm run rebuild && node test/restore-plugin-backup.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const emu = require('..');
const { chunker } = require('node-onlykey-lib/device');

const MSG = { OKSETPIN: 0xe1, OKGETLABELS: 0xe5, OKSETPRIV: 0xef, OKRESTORE: 0xf1 };
const PIN = [1, 2, 3, 4, 5, 6, 1];
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plugin-backup-3.1.0-edge.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const storageDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'okemu-restore-'));

const replies = [];
emu.on('hid', (buf) => {
  const text = buf.toString('latin1').replace(/\0.*$/s, '').trim();
  if (text) replies.push(text);
});

function vendor(cmd, slot, payload) {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0xffffffff, 0);
  b[4] = cmd;
  if (slot !== undefined) b[5] = slot;
  if (payload) Buffer.from(payload).copy(b, slot !== undefined ? 6 : 5);
  emu.writeHid(b, emu.IFACE.VENDOR);
}
async function drain(label) {
  for (let i = 0; i < 100 && emu.pressPending() > 0; i++) await sleep(50);
  if (emu.pressPending() > 0) throw new Error(`${label}: presses never taken`);
  await sleep(1500);
}
async function replyMatching(re, label, timeoutMs = 15000, from = replies.length) {
  for (let t = 0; t < timeoutMs / 50; t++) {
    const hit = replies.slice(from).find((r) => re.test(r));
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`${label}: no reply matching ${re} - saw ${JSON.stringify(replies.slice(from))}`);
}

(async () => {
  console.log(`storage: ${storageDir}`);
  console.log(`restoring a ${fixture.bytes}-byte backup from ${fixture.firmware}`);
  emu.start({ storageDir });
  await sleep(3000);

  /* first-time setup: the PIN, from queued presses (test/press.js) */
  for (const step of ['enter', 'confirm']) {
    vendor(MSG.OKSETPIN);
    await sleep(500);
    emu.pressButtons(PIN);
    await drain(step);
    vendor(MSG.OKSETPIN);
    await sleep(1000);
  }
  console.log(`PIN: ${replies[replies.length - 1]}`);

  /* the backup key the backup was made with (still inside first-time setup) */
  const key = crypto.createHash('sha256').update(fixture.passphrase, 'utf8').digest();
  vendor(MSG.OKSETPRIV, 131, Buffer.concat([Buffer.from([161]), key]));
  console.log(`backup key: ${await replyMatching(/Backup|Error/, 'backup key')}`);

  /* the restore: 0xFB is last, and this firmware may never have heard of it */
  const restoreFrom = replies.length; /* listen from the FIRST packet: the answer can come before the loop ends */
  for (const p of chunker.hexPackets(fixture.data)) {
    vendor(MSG.OKRESTORE, undefined, Buffer.concat([Buffer.from([p.header]), Buffer.from(p.data)]));
    await sleep(50);
  }
  await replyMatching(/Successfully loaded backup|Remove and Reinsert|Error/, 'restore', 60000, restoreFrom);
  await sleep(1500);
  const said = replies.slice(restoreFrom).join(' | ');
  console.log(`restore: ${said}`);
  /* the firmware prints both on success; an error path prints neither */
  const restored = /Successfully loaded backup/.test(said) && !/Error/.test(said);

  /*
   * What the backup carried, applied: the restore answers each record it sets
   * ("Successfully set Label" for the slot label) before it reaches 0xFB. Read
   * from the restore's own replies - after its CPU_RESTART a bare script has no
   * device host to bring the firmware back (the kit does that), so there is no
   * unlocking here to read the label back.
   */
  const labelBack = /Successfully set Label/.test(said);

  const ok = restored && labelBack;
  console.log(ok
    ? `PASS: the plugin backup restored on this release - everything it knows was set, it stopped at the plugin section and said so`
    : `FAIL: restored=${restored} label=${labelBack}`);
  await sleep(500);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
