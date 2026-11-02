'use strict';
/*
 * 0017: a tunnel connect clears the duplicate mark of a request that never reached its final packet.
 *
 * Through the WebAuthn tunnel the firmware drops a request packet whose opt3 is not above the last one it took
 * (last_request_opt3, ok_extension.cpp - Windows 10 1903 sent every request twice), and forgets the mark only when a
 * request's final packet is handled. A request cut off before its final packet - the browser cancelled the next
 * ceremony (on Windows a key press dismisses its security prompt), the page closed - leaves the mark set. A page numbers
 * its packets from 1 (the lib's counter starts with the page), so after a reload its requests are answered with an empty
 * success - dropped - until its numbers pass the old mark. Seen on blue-key in the Windows web app (2026-11-02): a
 * reloaded page's reads failed "chunk 1 of 1 was answered CTAP1_SUCCESS" several times, then worked.
 *
 * The test: page A connects and starts a 1152-byte request at slot 128 (the derived X-Wing decapsulation, which the
 * default webcrypt level lets through), numbered from 200; its second ceremony is refused as a browser refuses a
 * cancelled one, so the key has taken the first packet only. Page B numbers from 1 (the lib's counter seam), connects,
 * and reads an agent public key - one packet, no press, through the duplicate check (a derive is an OKCONNECT and is
 * not). 3.1.0: dropped - FAIL. Patched: the connect cleared the mark, the read is answered - PASS. The read is let
 * through the tunnel by the ctap_bridge plugin: the soft key under test is built with it.
 *
 * Standalone, run by the kit from this folder on a soft key built with the fixes to judge, DEBUG:
 *   OKEMU_ROOT=<emulator built with the fixes to judge> node bin/okt.js run <this file>
 */
const path = require('path');
const os = require('os');

const KIT = process.env.OKT_KIT || path.join(os.homedir(), 'project/onlykey/onlykey-testing');
const { describe, it } = require(path.join(KIT, 'lib/harness'));
const { pluginCtx } = require(path.join(KIT, 'lib/plugin-ctx'));

const ctx = pluginCtx({ debug: true });
const SLOT = 128;
const CUT_AT = 201; /* page A's second packet: refused before the key sees it */

describe('0017: a tunnel connect clears the duplicate mark of an unfinished request', { state: 'initialized', timeoutMs: 120000 }, () => {
  it('a new page numbering from 1 is answered after a request was cut off before its final packet', async ({ device, assert, signal, log }) => {
    await device.restart({ signal });
    await device.ensureUnlocked(ctx.PINS.primary, { signal });
    const Rectify = ctx.requireLib('@bmatusiak/rectify');
    const { createWebAuthnCtap } = ctx.requireLib('node-onlykey-lib/transport/webauthn');
    const { chunk } = ctx.requireLib('node-onlykey-lib/protocol');
    const { MSG } = ctx.okmsg;

    /* one page: the lib's browser stack on the kit's device; `refuse` sees each request's keyhandle */
    async function page(refuse) {
      const plugins = ['host', 'transport/tunnel', 'session', 'device', 'okcrypto'].map((p) => ctx.requireLib(`node-onlykey-lib/plugins/${p}`));
      const { window } = ctx.kit.webenv.create(device, { signal });
      const creds = window.navigator.credentials;
      const credentials = refuse ? {
        create: (o) => creds.create(o),
        get: (o) => {
          const id = new Uint8Array(o.publicKey.allowCredentials[0].id);
          if (refuse(id)) {
            const e = new Error('The operation either timed out or was not allowed.');
            e.name = 'NotAllowedError';
            return Promise.reject(e);
          }
          return creds.get(o);
        },
      } : creds;
      plugins.config = { okcrypto: { ctap: createWebAuthnCtap({ credentials }) } };
      const app = await new Promise((resolve, reject) => {
        const a = Rectify.build(plugins, (err, started) => (err ? reject(err) : resolve(started)));
        a.start();
      });
      await app.services.okcrypto.connectTunnel();
      return app;
    }

    /* page A: a request cut off after its first packet (keyhandle [cmd, opt1, opt2, opt3, ...] - ctap.js encodeRequest) */
    chunk._resetPacketCounter(CUT_AT - 2);
    let refusedAt = null;
    const a = await page((id) => {
      if (id[0] === MSG.OKDECRYPT && id[3] === CUT_AT) { refusedAt = CUT_AT; return true; }
      return false;
    });
    try {
      let cut = null;
      try { await a.services.okcrypto.tunnelRequest(MSG.OKDECRYPT, SLOT, new Uint8Array(1152).fill(0xab), { timeoutMs: 15000 }); } catch (e) { cut = String(e && e.message); }
      assert.equal(refusedAt, CUT_AT, `the request was not cut at its packet ${CUT_AT} (${cut ? cut.slice(0, 80) : 'it was answered'})`);
      log(`page A: packet ${CUT_AT - 1} taken, packet ${CUT_AT} refused by the browser - ${String(cut).slice(0, 60)}`);
    } finally {
      try { await a.destroy(); } catch { /* the test's verdict stands */ }
    }

    /* page B: numbered from 1 again, a fresh connect, one read through the duplicate check (an agent public key, OKGETPUBKEY - the ctap_bridge plugin lets it through) */
    chunk._resetPacketCounter(0);
    const b = await page(null);
    try {
      const pub = await b.services.okcrypto.agent.publicKey({ ssh: { user: 'okedge', host: 'test-0017' } }, { timeoutMs: 15000 });
      log(`page B: the read answered (${pub && pub.length} bytes)`);
      assert.ok(pub && pub.length === 32, 'page B\'s read came back without a public key');
    } finally {
      try { await b.destroy(); } catch { /* the test's verdict stands */ }
    }
  });
});
