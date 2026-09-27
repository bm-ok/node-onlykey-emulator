#!/usr/bin/env node
/*
 * press.js - prove pressButtons() reaches the firmware as the button asked for.
 *
 *   node test/press.js [storageDir]
 *
 * Runs a FRESH device in-process (a temp storage dir unless one is given, so it
 * never touches the daemon's key) and sets a PIN with it: OKSETPIN, the digits
 * through pressButtons(), OKSETPIN, the digits again, OKSETPIN. The firmware
 * only reports the PIN set if both entries matched, digit for digit - so a
 * press that went missing, arrived twice, or arrived as the wrong button (the
 * old pin table turned button 1 into 5) fails it.
 *
 * pressButtons() hands presses to src/okemu_press.cpp, not to the DEBUG
 * console, so this is meant to pass on a production build too. On a DEBUG
 * build the console also narrates each digit, which is printed as a second
 * witness.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const emu = require('..');   /* the module is the device instance */

const OKSETPIN = 0xE1;
const PIN = [1, 2, 3, 4, 5, 6, 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const storageDir = process.argv[2] ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'okemu-press-'));

const replies = [];
const digits = [];

emu.on('hid', (buf) => {
  const text = buf.toString('latin1').replace(/\0.*$/s, '').trim();
  if (text) replies.push(text);
});
emu.on('log', (s) => {
  for (const m of s.matchAll(/appended with (\d)/g)) digits.push(Number(m[1]));
});

function vendor(cmd) {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0xFFFFFFFF, 0);
  b[4] = cmd;
  emu.writeHid(b, emu.IFACE.VENDOR);
}

async function drain(label) {
  for (let i = 0; i < 100 && emu.pressPending() > 0; i++) await sleep(50);
  if (emu.pressPending() > 0) throw new Error(`${label}: presses never taken`);
  await sleep(1500);   /* the last press still has to clear key_off > 2 */
}

(async () => {
  console.log(`storage: ${storageDir}`);
  emu.start({ storageDir });
  await sleep(3000);   /* calibration and the first sense rounds */

  const r0 = emu.rounds();
  await sleep(1000);
  console.log(`sense rounds in 1s: ${emu.rounds() - r0}`);

  /*
   * Four OKSETPINs, as the App sends them: open entry, close it ("Successful
   * PIN entry"), open the confirmation, close it. Only the last reply says
   * whether the two entries matched.
   */
  for (const step of ['enter', 'confirm']) {
    vendor(OKSETPIN);
    await sleep(800);
    emu.pressButtons(PIN);
    await drain(step);
    vendor(OKSETPIN);
    await sleep(1500);
  }

  console.log('replies:', JSON.stringify(replies));
  if (digits.length) console.log(`console saw digits: ${digits.join('')}`);

  const last = replies[replies.length - 1] || '';
  const ok = /success/i.test(last) && !/entry/i.test(last);
  console.log(ok ? `PASS: the PIN was set from queued presses ("${last}")`
                 : `FAIL: the last reply was "${last}"`);

  /*
   * Exit WITHOUT emu.stop(). On Windows, stop() after the device has handled
   * a message faults in teardown (ACCESS VIOLATION writing 0x24) - with no
   * presses involved, so it is not this path; it is an open item of its own.
   * Exiting with the firmware thread still running is what a respawn does
   * anyway. The PASS/FAIL line above is the verdict: the exit code of a
   * process torn down under a live native thread is not reliable on Windows.
   */
  await sleep(1000);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
