/*
 * remote-gadget-bridge.js - the emulated device presented on ANOTHER machine's USB port, through a Pi's gadget
 * (bin/relay.js; Brad, 2026-11-02: "the pi connected to windows looks like an onlykey"). The same surface as
 * gadget-bridge.js (start / stop / plug / unplug / plugged), so the daemon takes it in its place:
 *
 *   OKEMU_BRIDGE=remote OKEMU_RELAY=192.168.51.162:8795 node emulator/bin/daemon.js --storage <dir> --socket <path>
 *
 * The firmware stays here - built, stored and driven (its buttons) where it always is; the Pi only carries its reports.
 * The relay's token is ~/.okemu-relay.token on both machines (lib/relay-protocol.js).
 *
 * THE CAPTURE (Brad, 2026-11-02: "this will also allow us to better analyse the protocol over the proxy"): with
 * OKEMU_CAPTURE=<file>, every report both ways is one line - "<iso time> <ms since start> <host>|<dev> <iface> <hex>" -
 * host the computer's write (host -> device), dev the firmware's (device -> host). A test key's traffic only, and the
 * file stays on this machine: it carries key bytes.
 *
 * A dropped connection is dialled again every RETRY_MS until it is back - the relay is a cable, and a cable that comes
 * back is plugged in again (the relay plugs it when a firmware connects).
 */
'use strict';

const fs = require('fs');
const net = require('net');
const { INTERFACES } = require('./hid-descriptors');
const { VERSION, PORT, send, readLines, token } = require('./relay-protocol');

const RETRY_MS = 2000;

class RemoteGadgetBridge {
  constructor(emu, { relay = process.env.OKEMU_RELAY, capture = process.env.OKEMU_CAPTURE, log = (l) => console.log(`[remote-bridge] ${l}`) } = {}) {
    if (!relay) throw new Error('OKEMU_RELAY=<host>[:port] names the Pi relay');
    const [host, port] = String(relay).split(':');
    this.emu = emu;
    this.host = host;
    this.port = Number(port) || PORT;
    this.log = log;
    this.sock = null;
    this.ready = false;
    this.cable = false;
    this.stopped = false;
    this.capture = capture ? fs.createWriteStream(capture, { flags: 'a', mode: 0o600 }) : null;
    this.t0 = Date.now();
    this.sizes = new Map(INTERFACES.map((s) => [s.iface, s.inSize]));
  }

  _cap(dir, iface, buf) {
    if (!this.capture) return;
    this.capture.write(`${new Date().toISOString()} ${Date.now() - this.t0} ${dir} ${iface} ${Buffer.from(buf).toString('hex')}\n`);
  }

  start() {
    this.token = token();
    this._onStream = ({ buffer, iface, dir }) => {
      if (dir !== 'out' || !this.ready) return;
      /* the reports as the key sends them: one per interface's report size (gadget-bridge.js does the same) */
      const size = this.sizes.get(iface) || 64;
      for (let off = 0; off < buffer.length; off += size) {
        const chunk = Buffer.alloc(size);
        buffer.copy(chunk, 0, off, Math.min(off + size, buffer.length));
        this._cap('dev', iface, chunk);
        send(this.sock, { t: 'report', iface, b64: chunk.toString('base64') });
      }
    };
    this.emu.on('stream', this._onStream);
    this._dial();
    return this;
  }

  _dial() {
    if (this.stopped) return;
    const sock = net.connect(this.port, this.host);
    this.sock = sock;
    sock.on('error', () => {});
    sock.on('connect', () => send(sock, { t: 'hello', v: VERSION, token: this.token }));
    readLines(sock, (m) => {
      if (m.t === 'ready') { this.ready = true; this.log(`connected to the relay ${this.host}:${this.port}`); return; }
      if (m.t === 'refused') { this.log(`the relay refused: ${m.why}`); this.stopped = true; sock.destroy(); return; }
      if (m.t === 'plugged') { this.cable = !!m.plugged; return; }
      if (m.t === 'host') {
        const buf = Buffer.from(String(m.b64 || ''), 'base64');
        this._cap('host', m.iface, buf);
        this.emu.writeHid(buf, m.iface);
      }
    });
    sock.on('close', () => {
      const was = this.ready;
      this.ready = false;
      this.cable = false;
      if (this.sock === sock) this.sock = null;
      if (was) this.log('the relay went away - dialling again');
      if (!this.stopped) setTimeout(() => this._dial(), RETRY_MS);
    });
  }

  stop() {
    this.stopped = true;
    if (this._onStream) this.emu.off('stream', this._onStream);
    if (this.sock) this.sock.destroy();
    if (this.capture) this.capture.end();
  }

  get plugged() { return this.cable; }

  /*
   * The state is taken at once: the daemon says the cable moved right after plug()/unplug() (ipc publishPlugged), before
   * the relay's answer can arrive - its "plugged" corrects it if the Pi could not.
   */
  plug() {
    if (!this.ready || this.cable) return false;
    send(this.sock, { t: 'plug' });
    this.cable = true;
    return true;
  }

  unplug() {
    if (!this.ready || !this.cable) return false;
    send(this.sock, { t: 'unplug' });
    this.cable = false;
    return true;
  }
}

module.exports = RemoteGadgetBridge;
