#!/usr/bin/env node
/*
 * hardware.js - the board option, as the FIRMWARE sees it.
 *
 *   node test/hardware.js
 *
 * 1. Detection. Each board boots a fresh device in its own process (start()
 *    is once per process) and reports what the firmware's own detection
 *    settled on - calibratecaptouch() reading SIM_SDID's PINID and analog pin
 *    A12. onlykey and onlykey-bga must come out OnlyKey, duo must come out
 *    DUO, and none may reboot while deciding (a disagreement between its
 *    re-checks is a CPU_RESTART).
 *
 * 2. A DUO PIN with digits 4-6, the way a DUO gets one. A DUO's PIN is not
 *    typed on its buttons: the App sends it (OnlyKey-App sendPinDUO(): OKSETPIN,
 *    0xFF, then the primary, second and self-destruct PINs as ASCII digits in
 *    16-byte fields - okcore_quick_setup()). The buttons only UNLOCK it, and
 *    payload() reads a press of 21+ rounds as button + 3 while it is locked.
 *    So: set the PIN by message on a fresh emulated DUO, reboot into the same
 *    storage, unlock with pinPresses(). A wrong digit would leave it locked.
 *
 * Not for a build staged with OKEMU_MODEL=duo: that build is a DUO whatever
 * the board says, so the onlykey rows would fail by design.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OKSETPIN = 0xE1;
const PIN = '1425361';

/* ------------------------------------------------------------ child */

async function child(role, hardware, storageDir) {
  const emu = require('..');
  const replies = [];
  let restarts = 0;
  emu.on('hid', (buf) => {
    const text = buf.toString('latin1').replace(/\0.*$/s, '').trim();
    if (text) replies.push(text);
  });
  emu.on('restart', () => { restarts++; });
  const vendor = (cmd) => {
    const b = Buffer.alloc(64);
    b.writeUInt32BE(0xFFFFFFFF, 0);
    b[4] = cmd;
    emu.writeHid(b, emu.IFACE.VENDOR);
  };
  const out = (o) => { process.stdout.write(`RESULT ${JSON.stringify(o)}\n`); process.exit(0); };

  emu.start({ storageDir, hardware });
  /*
   * The model is settled once calibration is through, which is not a fixed
   * round: calibratecaptouch() starts over whenever a pad reads high. A DUO is
   * known the moment onlykeyhw changes; an OnlyKey only by its not changing,
   * so that answer waits out a generous calibration first.
   */
  let model = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    await sleep(100);
    if (emu.detectedModel() === 'duo') { model = 'duo'; break; }
  }
  if (!model) model = emu.detectedModel();
  await sleep(500);   /* the re-checks after the decision, which restart on a disagreement */

  if (role === 'detect') out({ hardware, model, restarts, rounds: emu.rounds() });

  const drain = async () => {
    for (let i = 0; i < 200 && emu.pressPending() > 0; i++) await sleep(50);
    await sleep(1500);   /* the last press still has to clear key_off > 2 */
  };
  const reply = async (n) => { for (let t = 0; t < 200 && replies.length < n; t++) await sleep(50); };

  if (role === 'setpin') {
    /* sendPinDUO(['1425361'], true): 0xFF, then three 16-byte ASCII slots at 6, 22 and 38. */
    const b = Buffer.alloc(64);
    b.writeUInt32BE(0xFFFFFFFF, 0);
    b[4] = OKSETPIN;
    b[5] = 0xFF;
    Buffer.from(PIN, 'ascii').copy(b, 6);
    emu.writeHid(b, emu.IFACE.VENDOR);
    await reply(1);
    await sleep(2000);
    out({ hardware, model, replies, presses: emu.pinPresses(PIN) });
  }

  if (role === 'unlock') {
    const before = replies.length;
    emu.pressButtons(emu.pinPresses(PIN)); await drain();
    await sleep(1000);
    out({ hardware, model, presses: emu.pinPresses(PIN), replies: replies.slice(before), all: replies });
  }
}

/* ------------------------------------------------------------ parent */

function run(role, hardware, storageDir) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [__filename, '--child', role, hardware, storageDir],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${role} ${hardware}: timed out`)); }, 60000);
    p.on('exit', () => {
      clearTimeout(t);
      const m = buf.match(/^RESULT (.*)$/m);
      if (!m) return reject(new Error(`${role} ${hardware}: no result; output:\n${buf.slice(-2000)}`));
      resolve(JSON.parse(m[1]));
    });
  });
}

async function main() {
  let failed = 0;
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

  for (const [hardware, want] of [['onlykey', 'onlykey'], ['onlykey-bga', 'onlykey'], ['duo', 'duo']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `okemu-hw-${hardware}-`));
    const r = await run('detect', hardware, dir);
    check(r.model === want && r.restarts === 0,
      `${hardware}: the firmware detected ${r.model} (want ${want}), ${r.restarts} restarts, ${r.rounds} rounds`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okemu-hw-duo-pin-'));
  const set = await run('setpin', 'duo', dir);
  check(set.model === 'duo', `DUO setup: detected ${set.model}`);
  console.log(`DUO PIN ${PIN} set by message; replies: ${JSON.stringify(set.replies)}`);
  const un = await run('unlock', 'duo', dir);
  console.log(`DUO unlock with ${JSON.stringify(un.presses)}; replies: ${JSON.stringify(un.replies)}`);
  check(un.model === 'duo', `DUO after reboot: detected ${un.model}`);
  check(un.replies.some((t) => /^UNLOCKED/.test(t)), 'DUO: holds for 4-6 unlock it after a reboot');

  console.log(failed ? `FAIL: ${failed}` : 'PASS');
  process.exit(failed ? 1 : 0);
}

if (process.argv[2] === '--child') {
  child(process.argv[3], process.argv[4], process.argv[5]).catch((e) => { console.error(e); process.exit(2); });
} else {
  main().catch((e) => { console.error(e); process.exit(2); });
}
