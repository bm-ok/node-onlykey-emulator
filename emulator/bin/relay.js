#!/usr/bin/env node
/*
 * relay.js - a Pi's USB port as an OnlyKey whose firmware runs on another machine (Brad, 2026-11-02: "the linux box
 * connects to the pi's socket server, and uses the socket server to proxy between linux and pi, so the pi connected to
 * windows looks like an onlykey").
 *
 *   node emulator/bin/relay.js [--host 0.0.0.0] [--port 8795]
 *
 * The USB side is the emulator's own gadget bridge (lib/gadget-bridge.js), unchanged: it opens /dev/hidg0..3 and
 * plugs the cable through the gadget's UDC file - set up once by scripts/raspberry_pi/gadget-setup.sh, the UDC the
 * real port (use-udc.sh real). What it would hand to a firmware goes to the one connected firmware instead
 * (lib/remote-gadget-bridge.js, lib/relay-protocol.js), and what that firmware says comes back through it. With no
 * firmware connected the cable is out: the computer on the other end sees no key, as when one is unplugged.
 */
'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const GadgetBridge = require('../lib/gadget-bridge');
const { VERSION, PORT, send, readLines, token, tokensMatch } = require('../lib/relay-protocol');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const HOST = arg('--host', '0.0.0.0');
const LISTEN = Number(arg('--port', PORT));
const TOKEN = token({ make: true });
const log = (l) => console.log(`${new Date().toISOString()} [relay] ${l}`);

/* the firmware the bridge talks to: a stand-in whose two ends are the connected socket */
const emu = new EventEmitter();
let client = null;
emu.writeHid = (data, iface) => { if (client) send(client, { t: 'host', iface, b64: Buffer.from(data).toString('base64') }); };
const bridge = new GadgetBridge(emu);
let started = false;

function plug(want) {
  try {
    if (!started) { if (!want) return; bridge.start(); started = true; }
    else if (want) bridge.plug(); else bridge.unplug();
  } catch (err) { log(`${want ? 'plug' : 'unplug'}: ${err.message}`); }
  if (client) send(client, { t: 'plugged', plugged: bridge.plugged });
  log(`cable ${bridge.plugged ? 'in' : 'out'}`);
}

const server = net.createServer((sock) => {
  let accepted = false;
  const who = `${sock.remoteAddress}:${sock.remotePort}`;
  sock.on('error', () => {});
  const helloTimer = setTimeout(() => { if (!accepted) sock.destroy(); }, 5000);
  readLines(sock, (m) => {
    if (!accepted) {
      clearTimeout(helloTimer);
      if (m.t !== 'hello' || m.v !== VERSION || !tokensMatch(m.token, TOKEN)) { send(sock, { t: 'refused', why: 'not this relay\'s token or version' }); sock.end(); log(`refused ${who}`); return; }
      /* one firmware at a time: a second one is the first one back (a daemon restart) - it takes over */
      if (client && client !== sock) client.destroy();
      client = sock;
      accepted = true;
      log(`firmware connected from ${who}`);
      send(sock, { t: 'ready', plugged: started && bridge.plugged });
      plug(true);
      return;
    }
    if (m.t === 'report') emu.emit('stream', { buffer: Buffer.from(String(m.b64 || ''), 'base64'), iface: m.iface, dir: 'out' });
    else if (m.t === 'plug') plug(true);
    else if (m.t === 'unplug') plug(false);
  });
  sock.on('close', () => {
    clearTimeout(helloTimer);
    if (client !== sock) return;
    client = null;
    log(`firmware gone (${who}) - the cable out`);
    plug(false);
  });
});

server.listen(LISTEN, HOST, () => log(`listening on ${HOST}:${LISTEN} - the cable is out until a firmware connects`));
const bye = () => { try { if (started) bridge.unplug(); bridge.stop(); } catch { /* going */ } process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
