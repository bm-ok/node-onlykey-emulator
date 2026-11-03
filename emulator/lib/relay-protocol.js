/*
 * relay-protocol.js - the line protocol between a USB body (bin/relay.js, on a Pi plugged into another computer) and the
 * firmware that answers through it (lib/remote-gadget-bridge.js, in the emulator daemon on another machine).
 *
 * Brad, 2026-11-02: "the pi connected to windows looks like an onlykey" - the firmware stays where it is built and
 * driven, the Pi only carries its reports. One JSON object per line, report bytes in base64:
 *
 *   firmware -> body   { t: 'hello', v, token }        first; the body answers ready or refused
 *                      { t: 'report', iface, b64 }      a device -> host report (the body writes /dev/hidgN)
 *                      { t: 'plug' } | { t: 'unplug' }  the cable, as the daemon's plug/unplug
 *   body -> firmware   { t: 'ready', plugged }          the hello was taken
 *                      { t: 'refused', why }            it was not (and the socket closes)
 *                      { t: 'host', iface, b64 }        a host -> device report (read from /dev/hidgN)
 *                      { t: 'plugged', plugged }        the cable's state, after each change
 *
 * The token is a shared secret in a file on both machines (~/.okemu-relay.token): the reports carry a test key's
 * traffic, and a LAN is not a trust boundary.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const PORT = 8795;
const MAX_LINE = 1 << 16;
const TOKEN_FILE = process.env.OKEMU_RELAY_TOKEN_FILE || path.join(os.homedir(), '.okemu-relay.token');

const send = (sock, obj) => { if (!sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`); };

/* calls onMessage(obj) per line; a line that is not JSON, or too long, ends the socket */
function readLines(sock, onMessage) {
  let buffered = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buffered += chunk;
    if (buffered.length > MAX_LINE) { sock.destroy(); return; }
    for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { sock.destroy(); return; }
      onMessage(obj);
    }
  });
}

/* the shared token: read, or made once (owner-only) on the machine that runs first */
function token({ make = false } = {}) {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (err) {
    if (!make || err.code !== 'ENOENT') throw new Error(`no relay token at ${TOKEN_FILE} - copy it from the other machine`);
  }
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
  return t;
}

const tokensMatch = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

module.exports = { VERSION, PORT, TOKEN_FILE, send, readLines, token, tokensMatch };
