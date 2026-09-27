/*
 * okvhid-bridge.js - presents the emulated OnlyKey to Windows as real HID
 * devices.
 *
 * The Windows counterpart of uhid-bridge.js, and the same surface:
 * start/stop/plug/unplug/plugged, so bin/daemon.js does not care which host it
 * is on.
 *
 * Linux has a kernel call for this. /dev/uhid creates a HID device on request,
 * and configfs does it properly over a virtual UDC. Windows has neither: the
 * only way to add a HID device is to write a driver, so there is one -
 * ../../windows-driver, a UMDF 2 HID minidriver. It has to be built, signed
 * and installed once before this bridge can do anything, which is the one real
 * difference from the Linux bridges and the reason start() explains itself
 * rather than just throwing ENOENT.
 *
 *   emulator (this process)
 *         │  named pipe, \\.\pipe\okvhid-0..3
 *         ▼
 *   okvhid.dll ← WUDFRd.sys ← mshidumdf.sys ← HIDCLASS.SYS
 *         │
 *   4 HID collections, 1D50:60FC
 *
 * The driver is the pipe SERVER and this is the client, which is backwards
 * from how it looks but is forced: WUDFHost runs as a service account, so a
 * pipe created here would carry a default ACL the driver is not in, and Node
 * cannot write one that it would be.
 *
 * That also gives unplug for free. A pipe exists exactly as long as its device
 * does, so a device removed with windows-driver\hotplug.ps1 closes the pipe
 * and this reconnects on its own when it comes back - see plug()/unplug()
 * below for what those mean here, because they are not quite what they mean on
 * Linux.
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

const IFACES = require('./hid-descriptors').INTERFACES;

/* Must match windows-driver/src/public.h. PROTOCOL_VERSION in the HELLO frame
 * is the only thing that catches a mismatch. */
const PROTOCOL_VERSION = 2;
const PIPE_PREFIX = '\\\\.\\pipe\\okvhid-';
const FRAME_MAGIC = 0x48564b4f;          /* 'OKVH' little-endian */
const HEADER_SIZE = 12;
const MAX_REPORT = 64;

const FRAME_HELLO = 0;
const FRAME_INPUT = 1;
const FRAME_OUTPUT = 2;
const FRAME_FEATURE = 3;
const FRAME_UNPLUG = 4;                   /* emulator -> driver: remove the device */

const IFACE_KEYBOARD = 0;

/* Fast at first because the usual case is the driver coming up a moment later;
 * slow at the tail because the other usual case is no driver installed at all,
 * and a 250ms retry loop for the rest of the session is just noise. */
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 4000;

/* --------------------------------------------------------------- one pipe */

class Link {
  constructor(iface, bridge) {
    this.iface = iface;
    this.bridge = bridge;
    this.path = PIPE_PREFIX + iface;
    this.info = null;
    this.connected = false;

    this._sock = null;
    this._buf = Buffer.alloc(0);
    this._retry = RETRY_MIN_MS;
    this._timer = null;
    this._closed = false;
  }

  start() { this._closed = false; this._connect(); }

  _connect() {
    if (this._closed) return;
    const sock = net.connect({ path: this.path });
    this._sock = sock;

    sock.on('connect', () => {
      this._retry = RETRY_MIN_MS;
      this.connected = true;
      this._buf = Buffer.alloc(0);
      /* These are latency-bound messages, not a stream; Nagle would coalesce a
       * CTAP frame with whatever follows it. */
      sock.setNoDelay(true);
    });

    sock.on('data', (chunk) => this._feed(chunk));

    /* ENOENT is the ordinary case - no device, so no pipe. Only worth
     * reporting if we thought we were up. */
    sock.on('error', (err) => {
      if (this.connected && err.code !== 'ECONNRESET') {
        this.bridge._warn(`iface${this.iface}: ${err.message}`);
      }
    });

    sock.on('close', () => {
      const wasUp = this.connected;
      this.connected = false;
      this.info = null;
      this._sock = null;
      if (wasUp) this.bridge._onDisconnect(this.iface);
      this._scheduleRetry();
    });
  }

  _scheduleRetry() {
    if (this._closed || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._connect(); }, this._retry);
    this._timer.unref();
    this._retry = Math.min(this._retry * 2, RETRY_MAX_MS);
  }

  _feed(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    for (;;) {
      if (this._buf.length < HEADER_SIZE) return;

      const magic = this._buf.readUInt32LE(0);
      if (magic !== FRAME_MAGIC) {
        /*
         * There is no resync marker: the length field is how the next header
         * is found, so a bad magic means every subsequent offset is a guess.
         * Drop the connection rather than hand the firmware garbage shaped
         * like a report.
         */
        this.bridge._warn(`iface${this.iface}: framing lost - reconnecting`);
        if (this._sock) this._sock.destroy();
        return;
      }

      const kind = this._buf.readUInt32LE(4);
      const len = this._buf.readUInt32LE(8);
      if (this._buf.length < HEADER_SIZE + len) return;

      const payload = this._buf.subarray(HEADER_SIZE, HEADER_SIZE + len);
      this._buf = this._buf.subarray(HEADER_SIZE + len);
      this._dispatch(kind, payload);
    }
  }

  _dispatch(kind, payload) {
    if (kind === FRAME_HELLO) {
      if (payload.length < 28) return;
      this.info = {
        version: payload.readUInt32LE(0),
        interfaceNumber: payload.readUInt32LE(4),
        inputReportSize: payload.readUInt32LE(8),
        outputReportSize: payload.readUInt32LE(12),
        protocol: payload.readUInt32LE(16),
        subclass: payload.readUInt32LE(20),
        vendorId: payload.readUInt16LE(24),
        productId: payload.readUInt16LE(26),
      };
      if (this.info.version !== PROTOCOL_VERSION) {
        this.bridge._warn(
          `iface${this.iface}: driver speaks protocol v${this.info.version}, ` +
          `this bridge speaks v${PROTOCOL_VERSION} - rebuild one of them`);
      }
      this.bridge._onConnect(this.iface, this.info);
      return;
    }

    if (kind === FRAME_OUTPUT || kind === FRAME_FEATURE) {
      this.bridge._onOutput(this.iface, kind, Buffer.from(payload));
    }
  }

  /* device -> host. False means it went nowhere, which is not an error: an
   * unplugged token dropping its reports is the behaviour being emulated. */
  send(data) {
    if (!this.connected || !this._sock) return false;
    if (data.length > MAX_REPORT) return false;

    const frame = Buffer.allocUnsafe(HEADER_SIZE + data.length);
    frame.writeUInt32LE(FRAME_MAGIC, 0);
    frame.writeUInt32LE(FRAME_INPUT, 4);
    frame.writeUInt32LE(data.length, 8);
    data.copy(frame, HEADER_SIZE);
    this._sock.write(frame);
    return true;
  }

  /* Ask the driver to remove this device - see OKVHID_FRAME_UNPLUG. */
  sendUnplug() {
    if (!this.connected || !this._sock) return false;
    const frame = Buffer.alloc(HEADER_SIZE);
    frame.writeUInt32LE(FRAME_MAGIC, 0);
    frame.writeUInt32LE(FRAME_UNPLUG, 4);
    frame.writeUInt32LE(0, 8);
    this._sock.write(frame);
    return true;
  }

  close() {
    this._closed = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._sock) { this._sock.destroy(); this._sock = null; }
    this.connected = false;
  }
}

/* ------------------------------------------------------------------ bridge */

class OkvhidBridge {
  constructor(emu) {
    this.emu = emu;
    this.links = new Map();
    this._onStream = null;
    this._started = false;
  }

  /*
   * Which pipes exist right now. \\.\pipe\ is a real directory to Node, so
   * this is a listing rather than four speculative connects - it tells "the
   * driver is not installed" apart from "the driver is installed and refusing
   * us", which a failed connect cannot.
   */
  static presentPipes() {
    let names;
    try { names = fs.readdirSync('\\\\.\\pipe\\'); } catch { return null; }
    const found = [];
    for (let i = 0; i < IFACES.length; i++) {
      if (names.includes('okvhid-' + i)) found.push(i);
    }
    return found;
  }

  start() {
    if (process.platform !== 'win32') {
      throw new Error('the okvhid bridge is Windows-only; use uhid or gadget');
    }

    /*
     * Fail fast and clearly, the way uhid-bridge.js does for /dev/uhid. The
     * difference worth spelling out: on Linux the transport is a kernel
     * feature that needs a permission, here it is a driver that has to be
     * built and installed first, and "no pipes" is what both a missing driver
     * and missing devices look like.
     */
    const present = OkvhidBridge.presentPipes();
    if (present === null) {
      throw new Error('cannot list \\\\.\\pipe\\ - is this really Windows?');
    }
    if (present.length === 0) {
      const dir = path.resolve(__dirname, '..', '..', 'windows-driver');
      throw new Error(
        'no okvhid pipes - the driver is not installed, or its devices were ' +
        'never created (installing the driver alone does not create them). ' +
        `See ${dir}\\README.md`);
    }

    for (let iface = 0; iface < IFACES.length; iface++) {
      const link = new Link(iface, this);
      this.links.set(iface, link);
      link.start();
    }

    /* Device -> host. onStream carries every interface and both directions;
     * forward only the outbound half, to the pipe for that interface. */
    this._onStream = ({ buffer, iface, dir }) => {
      if (dir !== 'out') return;
      const link = this.links.get(iface);
      if (link) link.send(buffer);
    };
    this.emu.on('stream', this._onStream);

    this._started = true;
  }

  stop() {
    if (this._onStream) {
      this.emu.removeListener('stream', this._onStream);
      this._onStream = null;
    }
    for (const [, link] of this.links) link.close();
    this.links.clear();
    this._started = false;
  }

  /*
   * plug()/unplug() mean less here than they do on Linux, and pretending
   * otherwise would be worse than saying so.
   *
   * The Linux bridges own the device nodes, so they can create and destroy
   * them. Here the devices belong to Windows PnP: creating and removing them
   * needs an elevated token, which this process does not have and should not
   * want. So these detach and reattach the DATA path - Windows keeps
   * enumerating four HID collections either way, they simply stop answering.
   *
   * For a real removal, where the collections disappear from every application
   * holding them, use windows-driver\hotplug.ps1 from an elevated shell. This
   * bridge notices on its own: the pipe closes and it reconnects when the
   * device returns.
   */
  get plugged() {
    for (const [, link] of this.links) if (link.connected) return true;
    return false;
  }

  unplug() {
    if (!this._started) return false;
    let changed = false;
    for (const [, link] of this.links) {
      if (link.connected || link._sock) { link.close(); changed = true; }
    }
    return changed;
  }

  /*
   * Pull the cable: every device removes ITSELF, which - unlike the elevated
   * hotplug.ps1 removal - no application can veto. See OKVHID_FRAME_UNPLUG in
   * windows-driver/src/public.h. The pipes close as the devices go, and the
   * links then retry until "Plug in" brings the devices back. Needs no
   * elevation: the emulator is the key, and cutting its power is ours to do.
   * Returns how many devices were told.
   */
  pullCable() {
    let told = 0;
    for (const [, link] of this.links) if (link.sendUnplug()) told++;
    return told;
  }

  plug() {
    if (!this._started) return false;
    let changed = false;
    for (const [iface, link] of this.links) {
      if (link._closed) { link.start(); changed = true; }
      else if (!link.connected && !link._sock) { link.start(); changed = true; }
      void iface;
    }
    return changed;
  }

  /* ------------------------------------------------------------ internals */

  _warn(msg) { this.emu.emit('bridge-warning', msg); }

  _onConnect(iface, info) {
    this.emu.emit('bridge-connect', { iface, info });
  }

  _onDisconnect(iface) {
    this.emu.emit('bridge-disconnect', { iface });
  }

  _onOutput(iface, kind, data) {
    try {
      /*
       * A feature report on the keyboard interface is not an ordinary write.
       * It is OnlyKey's SET_REPORT side channel into setBuffer[], which
       * process_setreport() consumes and the OnlyKey app uses to send
       * configuration, so it has its own entry point - an interrupt OUT report
       * on that interface goes somewhere else entirely.
       */
      if (iface === IFACE_KEYBOARD && kind === FRAME_FEATURE) {
        this.emu.kbdSetReport(data);
      } else if (iface === IFACE_KEYBOARD) {
        /* LED state. The firmware has no use for it. */
      } else {
        this.emu.writeHid(data, iface);
      }
    } catch (err) {
      this._warn(`iface${iface}: ${err.message}`);
    }
  }
}

module.exports = OkvhidBridge;
