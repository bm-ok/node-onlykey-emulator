'use strict';
/*
 * The remote gadget bridge against a stand-in relay (no Pi, no /dev/hidg): the hello and its token, a firmware report
 * out in the interface's report size, a host report in to the firmware, the cable, and the capture's lines.
 *   node --test emulator/test/remote-bridge.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okemu-relay-'));
process.env.OKEMU_RELAY_TOKEN_FILE = path.join(dir, 'token');
fs.writeFileSync(process.env.OKEMU_RELAY_TOKEN_FILE, 'a'.repeat(64));
const { send, readLines } = require('../lib/relay-protocol');
const RemoteGadgetBridge = require('../lib/remote-gadget-bridge');

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

function fakeRelay(token) {
  const got = [];
  let sock = null;
  const server = net.createServer((s) => {
    readLines(s, (m) => {
      got.push(m);
      if (m.t === 'hello') {
        if (m.token !== token) { send(s, { t: 'refused', why: 'token' }); s.end(); return; }
        sock = s;
        send(s, { t: 'ready', plugged: false });
        send(s, { t: 'plugged', plugged: true });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port, host: (obj) => send(sock, obj) })));
}

test('a firmware report goes out in its interface\'s report size; a host report comes in; both are captured', async () => {
  const relay = await fakeRelay('a'.repeat(64));
  const emu = new EventEmitter();
  const wrote = [];
  emu.writeHid = (data, iface) => wrote.push({ iface, hex: Buffer.from(data).toString('hex') });
  const capture = path.join(dir, 'cap.txt');
  const b = new RemoteGadgetBridge(emu, { relay: `127.0.0.1:${relay.port}`, capture, log: () => {} }).start();
  try {
    await until(() => b.ready && b.plugged);
    emu.emit('stream', { buffer: Buffer.alloc(100, 7), iface: 1, dir: 'out' });
    emu.emit('stream', { buffer: Buffer.alloc(8, 1), iface: 1, dir: 'in' });
    await until(() => relay.got.filter((m) => m.t === 'report').length === 2);
    const reports = relay.got.filter((m) => m.t === 'report');
    assert.ok(reports.every((m) => Buffer.from(m.b64, 'base64').length === 64), 'two 64-byte reports for 100 bytes');
    relay.host({ t: 'host', iface: 1, b64: Buffer.from([1, 2, 3]).toString('base64') });
    await until(() => wrote.length === 1);
    assert.deepEqual(wrote[0], { iface: 1, hex: '010203' });
    assert.equal(b.unplug(), true);
    await until(() => relay.got.some((m) => m.t === 'unplug'));
  } finally {
    b.stop();
    relay.server.close();
  }
  await until(() => fs.existsSync(capture) && fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).length === 3);
  const lines = fs.readFileSync(capture, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(2, 4).join(' '));
  assert.deepEqual(lines, ['dev 1', 'dev 1', 'host 1']);
});

test('a relay that refuses the token is not dialled again', async () => {
  const relay = await fakeRelay('b'.repeat(64));
  const emu = new EventEmitter();
  emu.writeHid = () => {};
  const said = [];
  const b = new RemoteGadgetBridge(emu, { relay: `127.0.0.1:${relay.port}`, log: (l) => said.push(l) }).start();
  try {
    await until(() => said.some((l) => /refused/.test(l)));
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(relay.got.filter((m) => m.t === 'hello').length, 1);
    assert.equal(b.plugged, false);
  } finally {
    b.stop();
    relay.server.close();
  }
});
