/*
 * index.js - the JavaScript face of the OnlyKey emulator.
 *
 * Wraps the native addon in an EventEmitter and demuxes the single native
 * bus stream into named events. Interface numbers are usb_desc.h's, which is
 * what the firmware and the HID descriptors use:
 *
 *   0  Keyboard      device -> host      (HID1 in the UI)
 *   1  RawHID  FIDO  bidirectional       (HID2, usage page 0xF1D0)
 *   2  RawHID2 vendor bidirectional      (HID3, usage page 0xFFAB)
 *   3  SEREMU  debug bidirectional       (HID4, DEBUG builds only)
 */
'use strict';

const EventEmitter = require('events');
const path = require('path');

const native = require('./build/Release/onlykey_emulator.node');

const IFACE = {
  KEYBOARD: native.IFACE_KEYBOARD,
  FIDO: native.IFACE_FIDO,
  VENDOR: native.IFACE_VENDOR,
  SEREMU: native.IFACE_SEREMU,
};

const IFACE_NAME = {
  [IFACE.KEYBOARD]: 'keyboard',
  [IFACE.FIDO]: 'fido',
  [IFACE.VENDOR]: 'vendor',
  [IFACE.SEREMU]: 'seremu',
};

/*
 * The firmware's own debug button harness (okcore.cpp, touch_sense_loop):
 * a line of ASCII digits selects the buttons, '!' per hold tier modifies the
 * digit before it, and newline commits the line. The firmware replays the
 * presses one per loop() iteration, so a whole sequence goes in one write.
 *
 * This - not the analog touch pads - is the supported way to drive buttons,
 * per EXPLAINER.md line 15. It only exists in DEBUG firmware builds.
 */
/* Press modes (tap / press / hold) and their firmware durations - see
 * lib/press-modes.js, the one place a mode becomes ticks. */
const { MODE_TICKS, PRESS_MODES } = require('./lib/press-modes');

/* src/okemu_press.h OKEMU_PRESS_QUEUE_MAX - presses waiting at once. */
const PRESS_QUEUE_MAX = 32;

class OnlyKeyEmulator extends EventEmitter {
  constructor() {
    super();
    this.started = false;
    this.led = [];
  }

  /**
   * @param {object}  [opts]
   * @param {string}  [opts.storageDir] where flash.bin / eeprom.bin live
   */
  start(opts = {}) {
    if (this.started) throw new Error('emulator already started');

    const storageDir = path.resolve(
      opts.storageDir || path.join(__dirname, '.onlykey-storage')
    );

    native.start({
      storageDir,

      onLed: (pixels) => {
        this.led = pixels;
        this.emit('led', pixels);
      },

      onStream: (buffer, iface, dir) => {
        // Raw bus trace first - this is what the UI debug log renders.
        this.emit('stream', { buffer, iface, name: IFACE_NAME[iface], dir });

        if (dir === 'out') {
          switch (iface) {
            case IFACE.KEYBOARD: this.emit('keyboard', buffer); break;
            case IFACE.SEREMU:   this.emit('log', buffer.toString('latin1')); break;
            default:             this.emit('hid', buffer, iface); break;
          }
        }
      },

      onRestart: () => this.emit('restart'),
    });

    this.started = true;
    this.storageDir = storageDir;
    return this;
  }

  /**
   * Press button n (1..6) in one of the press modes: 'tap' (default), 'press'
   * or 'hold' - see MODE_TICKS. A caller never names a duration; it says what
   * kind of press it means, and the UI decides that from its own timer.
   * @param {number} n
   * @param {string} [mode='tap']
   */
  pressButton(n, mode = 'tap') {
    this.pressButtons([{ button: n, mode }]);
  }

  /**
   * Press a sequence. The firmware takes them one at a time from its own
   * dispatch, so this is the reliable way to enter a PIN - no host-side delay
   * between digits to get wrong.
   *
   * Works on a PRODUCTION build. This used to write "1#128\n" to the DEBUG
   * console on SEREMU, which a release build does not compile, so every press
   * silently did nothing there. Presses now go through src/okemu_press.cpp,
   * which stage.js wires into touch_sense_loop() on every build.
   *
   * @param {Array<number|{button: number, mode?: string}>} presses
   *   button numbers (each a tap), or {button, mode} objects
   */
  pressButtons(presses) {
    const buttons = [];
    const ticks = [];
    for (const p of presses) {
      const { button, mode = 'tap' } = typeof p === 'object' ? p : { button: p };
      if (!Number.isInteger(button) || button < 1 || button > 6) {
        throw new RangeError(`button must be 1..6, got ${button}`);
      }
      if (!Object.prototype.hasOwnProperty.call(MODE_TICKS, mode)) {
        throw new RangeError(`mode must be one of ${PRESS_MODES.join(', ')}, got ${mode}`);
      }
      buttons.push(button);
      ticks.push(MODE_TICKS[mode]);
    }

    // Checked BEFORE queueing, so a line that does not fit presses nothing
    // rather than its first few digits - half a PIN is a wrong PIN attempt.
    const room = PRESS_QUEUE_MAX - native.pressPending();
    if (buttons.length > room) {
      throw new RangeError(`${buttons.length} presses, the queue has room for ${room}`);
    }
    const accepted = native.pressQueue(buttons, ticks);
    if (accepted !== buttons.length) {
      throw new Error(`press queue took ${accepted} of ${buttons.length}`);
    }
  }

  /** Presses queued but not yet taken by the firmware; 0 once all are in. */
  pressPending() { return native.pressPending(); }

  /** Sense rounds the firmware has completed since start - proof it is running. */
  rounds() { return native.rounds(); }

  /**
   * Restart the device, on any build.
   *
   * This used to send '8' on the DEBUG console, which a production build does
   * not compile. What '8' did was CPU_RESTART(), and okemu_restart.cpp already
   * turns a CPU_RESTART into this same 'restart' event - the host respawns the
   * firmware and flash/eeprom persist, exactly as a reset on hardware. So the
   * host raises it directly. factoryReset() restarts the same way.
   *
   * Not a button-3 hold: that only locks and restarts an UNLOCKED key. On a
   * locked one a press is a PIN digit.
   */
  restartDevice()  { this.emit('restart'); }

  /*
   * Debug-only firmware command paths on the SEREMU channel. The wipes spell
   * out their own confirmation ('0C'/'9C') so that no single stray byte can
   * erase the device; there is no separate confirm step to follow them with.
   * A production build has no such console - factoryReset() is the wipe that
   * works everywhere.
   */
  wipeUserspace()  { this.writeHid(Buffer.from('0C\n', 'latin1'), IFACE.SEREMU); }
  wipeAll()        { this.writeHid(Buffer.from('9C\n', 'latin1'), IFACE.SEREMU); }

  /*
   * HID CONTROL TRANSFERS ON THE KEYBOARD INTERFACE, WHICH ARE NOT writeHid().
   *
   * SET_REPORT (0x0921) and GET_REPORT (0x01a1) are a different transfer type
   * from the interrupt OUT reports writeHid() sends, and they reach a different
   * handler: process_setreport() in okcore.cpp, which is the Yubikey-style
   * HMAC-SHA1 challenge-response channel. Nothing else in this API can reach it
   * - an interrupt OUT report on IFACE.KEYBOARD is simply not a control
   * transfer, so device.send(KEYBOARD, ...) goes somewhere else entirely.
   *
   * The firmware side has been ported all along (core-override/okemu_usb.cpp
   * carries the whole state machine, including the multi-report 0xC0..0xC3 read
   * and the waiting-for-a-press path) and uhid-bridge.js already drives it for
   * the gadget. These two methods are what let an IPC client reach the same
   * place without a kernel device node.
   */
  kbdSetReport(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    return native.kbdSetReport(buffer);
  }

  /** Device -> host, the answer side of the same channel. Returns a Buffer. */
  kbdGetReport() {
    return native.kbdGetReport();
  }

  /** Host -> device on a writable interface (FIDO, vendor or SEREMU). */
  writeHid(buffer, iface = IFACE.FIDO) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    native.sendHid(buffer, iface);
  }

  /** Raw analog touch pad state. The HID4 path above is the supported route. */
  setButton(n, down) { native.setButton(n, !!down); }

  /**
   * Wipe flash + EEPROM back to erased (0xFF), then reboot onto them.
   *
   * The wipe alone did nothing visible: the firmware kept running on the
   * state it had already loaded into RAM, and kept answering INITIALIZED.
   * okemu_factory_reset() sets a "restart requested" flag that nothing reads,
   * so the reboot never came. It is raised here instead as the same 'restart'
   * event the firmware's own CPU_RESTART() produces - the owner (daemon.js)
   * exits on it, its supervisor respawns it, and setup() then runs against
   * the erased storage, as a real key would after a wipe and a power cycle.
   */
  factoryReset() {
    native.factoryReset();
    this.emit('restart');
  }

  stop() {
    if (!this.started) return;
    native.stop();
    this.started = false;
  }
}

module.exports = new OnlyKeyEmulator();
module.exports.OnlyKeyEmulator = OnlyKeyEmulator;
module.exports.IFACE = IFACE;
module.exports.IFACE_NAME = IFACE_NAME;
