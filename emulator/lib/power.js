/*
 * power.js - unplug / plug in, modelled as what it physically is.
 *
 * An OnlyKey is bus-powered. There is no scenario in which it is unplugged and
 * still running, so "unplug" here means both halves:
 *
 *   1. unbind the gadget from the UDC, so Linux stops seeing the device at all
 *      (hidraw nodes disappear, and are renumbered on re-plug exactly as they
 *      are on real re-enumeration), and
 *   2. stop the emulator process, so the firmware loses power and its RAM.
 *
 * The earlier behaviour - tear down the interfaces but leave the firmware
 * running with RAM intact - made the firmware's own recovery instruction a
 * lie. exceeded_login_attempts() is `while (1==1) { hidprint("...remove
 * OnlyKey and reinsert..."); }`, an infinite loop with no exit: on hardware
 * removing the key cuts power and the MCU resets, which is precisely how you
 * escape it. Against an emulator that kept running, "remove and reinsert" did
 * nothing and the device stayed wedged until pm2 was restarted by hand.
 *
 * Stopping has to go through pm2, not process.exit(): pm2's whole job here is
 * to respawn the daemon after CPU_RESTART(), so a plain exit would come
 * straight back up. `pm2 stop` marks it stopped and it stays down.
 *
 * ON WINDOWS there is no UDC. The bus half is the okvhid driver's root
 * devices, and removing those needs an elevated token (windows-driver/
 * hotplug.ps1) that this GUI does not run with. So unplug there is the POWER
 * half only: the emulator stops, its pipe clients close, and the four devices
 * stay enumerated but silent until "Plug in" - a key with no power, still in
 * the port. What clients see is a device that stops answering, not one that
 * disappears; a real removal is hotplug.ps1 -Off, elevated.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

const GADGET_DIR = process.env.OKEMU_GADGET_DIR
  || '/sys/kernel/config/usb_gadget/onlykey';
const UDC_FILE = `${GADGET_DIR}/UDC`;
const PM2_APP = process.env.OKEMU_PM2_APP || 'onlykey-emulator';
const PM2_BIN = process.env.OKEMU_PM2_BIN || 'pm2';
const WIN = process.platform === 'win32';

/** Name of the controller to bind to, e.g. "dummy_udc.0". */
function udcName() {
  try {
    const bound = fs.readFileSync(UDC_FILE, 'utf8').trim();
    if (bound) return bound;
  } catch { /* fall through */ }
  try {
    return fs.readdirSync('/sys/class/udc')[0] || null;
  } catch { return null; }
}

function isBound() {
  try { return fs.readFileSync(UDC_FILE, 'utf8').trim().length > 0; }
  catch { return false; }
}

function pm2(action) {
  return new Promise((resolve, reject) => {
    /*
     * On Windows `pm2` is pm2.cmd, a batch file, and execFile() cannot run one
     * without a shell: it failed "spawn pm2 ENOENT" even with pm2 installed.
     * The arguments are fixed strings, so the shell has nothing to interpret.
     * Passed as ONE command string there: an args array with shell:true is
     * deprecated (DEP0190), since the shell only concatenates it anyway.
     */
    const done = (err, stdout, stderr) => {
      if (err) reject(new Error(`pm2 ${action} ${PM2_APP}: ${stderr || err.message}`));
      else resolve(stdout);
    };
    if (WIN) exec(`${PM2_BIN} ${action} ${PM2_APP}`, { timeout: 20000, windowsHide: true }, done);
    else execFile(PM2_BIN, [action, PM2_APP], { timeout: 20000 }, done);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cut power: detach from the bus, then stop the firmware process. */
async function powerOff() {
  if (WIN) { await pm2('stop'); return null; }   /* power half only - see top */
  const name = udcName();          /* remember it before unbinding */
  if (isBound()) fs.writeFileSync(UDC_FILE, '\n');
  await pm2('stop');
  return name;
}

/**
 * Restore power: start the firmware first so it has /dev/hidgN open, then
 * attach to the bus. Binding before the daemon is up would enumerate a device
 * that answers nothing.
 */
async function powerOn() {
  await pm2('start');
  /* Windows: the daemon reattaches to the okvhid pipes itself; no bus step. */
  if (WIN) return null;
  await sleep(1500);
  const name = udcName();
  if (!name) throw new Error('no UDC available - run scripts/gadget-setup.sh');
  if (!isBound()) fs.writeFileSync(UDC_FILE, `${name}\n`);
  return name;
}

/**
 * Rebuild the addon and come back up on it: stop, build, start.
 *
 * The daemon used to build ITSELF while running, then exit into the new
 * module. On Windows that cannot work - a loaded addon is a locked DLL, and
 * the link step failed "lld-link: failed to write output
 * onlykey_emulator.node" because the process asking for the build held the
 * file. Stopping first releases it, on every platform, so the sequence is the
 * same everywhere and has no per-OS trick in it.
 *
 * The emulator is started again whatever the build did: a failed link leaves
 * the previous module in place, so a failure costs a restart and nothing else.
 * Resolves { ok, output } - output is the tail of the build log to show.
 */
async function rebuild() {
  await pm2('stop');
  const build = await new Promise((resolve) => {
    exec('npm run build', {
      windowsHide: true,   /* no console window flashing up on Windows */
      cwd: path.join(__dirname, '..'),
      timeout: 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.split(/\r?\n/).slice(-25).join('\n');
      resolve({ ok: !err, output });
    });
  });
  await pm2('start');
  return build;
}

module.exports = { powerOff, powerOn, rebuild, isBound, udcName, UDC_FILE, GADGET_DIR };
