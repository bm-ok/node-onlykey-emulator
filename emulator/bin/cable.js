#!/usr/bin/env node
/*
 * cable.js - plug or unplug the running emulator's USB cable, without the GUI - press.js's sibling.
 *
 *   ./emulator/bin/cable.js out [--socket=P]     the computer sees the key unplugged
 *   ./emulator/bin/cable.js in  [--socket=P]     and plugged in again
 *
 * What the GUI's Unplug button does (the daemon's set-plugged: bridge.unplug()/plug()) - the firmware keeps running and
 * keeps its RAM, only the USB link goes. Through a Pi relay (OKEMU_BRIDGE=remote; Brad, 2026-11-02: "we can bring the
 * gadget down and up, and windows will think its unplugged") that is the Pi's gadget unbound and bound again: the
 * other computer hears the key leave and come back, with no hand on a cable.
 *
 * Like press.js it LISTENS on the socket the daemon dials (ipc-host.js), so it must not run beside the GUI or another
 * press.js; it ends once the daemon says the cable moved.
 */
'use strict';

const IpcHost = require('../lib/ipc-host');

const want = process.argv[2];
if (want !== 'in' && want !== 'out') { console.error('usage: cable.js in|out [--socket=P]'); process.exit(2); }
const sock = process.argv.find((a) => a.startsWith('--socket='));
const host = new IpcHost({ socketPath: sock ? sock.slice(9) : undefined });

try { host.listen(); } catch (err) { console.error(`cable: ${err.message}`); process.exit(1); }
const done = (code, msg) => { if (msg) console.error(`cable: ${msg}`); host.close(); process.exit(code); };
const timer = setTimeout(() => done(1, 'no emulator connected within 8 s - is it running?'), 8000);

host.once('ready', () => {
  host._send({ t: 'setPlugged', plugged: want === 'in' });
  /* the daemon answers with the cable's state once it has moved (ipc-peer publishPlugged) */
  const moved = setTimeout(() => done(1, 'the daemon did not say the cable moved within 8 s'), 8000);
  host.on('plugged', (m) => {
    if (!!(m && m.plugged) !== (want === 'in')) return;
    clearTimeout(timer);
    clearTimeout(moved);
    done(0, `the cable is ${want}`);
  });
});
