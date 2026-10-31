'use strict';
/*
 * 0016's raw HID half: a press for a USB request is not lost while a WebAuthn reply already delivered is still held.
 *
 * On the release, a WebAuthn reply stays stored for 5 s after it is delivered (pending_operation 0xF7, DATA_WIPE),
 * and the firmware's main loop drops every press it senses in that time (OnlyKey.ino: "pending_operation == 0xF6 ||
 * pending_operation == 0xF7" -> setcolor only, no payload()). A host that reads over WebAuthn and then asks for a
 * confirmation over USB within those 5 s never gets it: the press is sensed, dropped, and the request times out.
 * Seen on the box's desktop app (2026-10-31): the first press of a login after the bucket key's WebAuthn derive was
 * lost every time; the retry, after the wipe, worked.
 *
 * The test: one WebAuthn request (Edge HEAD through the tunnel, its reply delivered), then at once a USB Edge CERTIFY,
 * which always waits for a press and writes one link - pressed on the key's own "Edge: waiting for a press" (DEBUG
 * console), never on a timer. Release: the press is dropped, the certification times out - FAIL. Patched: its
 * arrival wipes the delivered reply, the press lands, one link - PASS.
 *
 * Standalone, run by the kit from this folder on a soft key built with edge + ctap_bridge, DEBUG:
 *   OKEMU_ROOT=<emulator built with the fixes to judge> node bin/okt.js run <this file>
 */
const path = require('path');
const os = require('os');

const KIT = process.env.OKT_KIT || path.join(os.homedir(), 'project/onlykey/onlykey-testing');
const { describe, it } = require(path.join(KIT, 'lib/harness'));
const { pluginCtx } = require(path.join(KIT, 'lib/plugin-ctx'));
const { kitPipe } = require(path.join(KIT, 'lib/libstack'));

const ctx = pluginCtx({ debug: true });
const SEQ_NONE = 0xffffffff;

describe('0016: a press for a USB request is not lost while a delivered WebAuthn reply is held', { state: 'initialized', timeoutMs: 180000 }, () => {
  it('a USB certification pressed within 5 s of a WebAuthn reply writes its link', async ({ device, assert, signal, log }) => {
    await device.restart({ signal });
    await device.ensureUnlocked(ctx.PINS.primary, { signal });

    /* the lib over USB: the kit's own pipe to the soft key (lib/libstack), with the Edge plugin */
    const Rectify = ctx.requireLib('@bmatusiak/rectify');
    const usbPlugins = ['host', 'transport/embedded', 'session', 'device', 'okcrypto', 'edge'].map((p) => ctx.requireLib(`node-onlykey-lib/plugins/${p}`));
    usbPlugins.config = { transport: { pipe: kitPipe(device).pipe } };
    const usbApp = await new Promise((resolve, reject) => {
      const a = Rectify.build(usbPlugins, (err, started) => (err ? reject(err) : resolve(started)));
      a.start();
    });
    const usb = usbApp.services.edge;
    /* a certification needs nothing set up: a press, and one link (the Edge kit test proves that much on its own) */
    const before = (await usb.head()).seq;

    /* the lib over WebAuthn (the kit's browser), as the Edge plugin's own WebAuthn test builds it */
    const plugins = ['host', 'transport/tunnel', 'session', 'device', 'okcrypto', 'edge'].map((p) => ctx.requireLib(`node-onlykey-lib/plugins/${p}`));
    const { createWebAuthnCtap } = ctx.requireLib('node-onlykey-lib/transport/webauthn');
    const { window } = ctx.kit.webenv.create(device, { signal });
    plugins.config = { okcrypto: { ctap: createWebAuthnCtap({ credentials: window.navigator.credentials }) } };
    const app = await new Promise((resolve, reject) => {
      const a = Rectify.build(plugins, (err, started) => (err ? reject(err) : resolve(started)));
      a.start();
    });
    try {
      const { okcrypto, edge: web } = app.services;
      await okcrypto.connectTunnel();
      /* the WebAuthn reply: delivered whole, now held for its 5 s */
      const h = await web.head();
      log(`WebAuthn HEAD: #${h.seq === null ? 'none' : h.seq} - its reply delivered; a USB certification follows at once`);

      /* the press on the key's own word that it waits (the Edge plugin's DEBUG line) */
      const waits = device.log.count(/Edge: waiting for a press/g);
      const t0 = Date.now();
      let pressedAt = 0;
      await usb.certify(new Uint8Array(require('crypto').randomBytes(32)), {
        timeoutMs: 25000,
        onPress: () => {
          device.log.waitForCount(/Edge: waiting for a press/g, waits + 1, { timeoutMs: 20000, signal })
            .then(() => { pressedAt = Date.now(); log(`the key waits (${pressedAt - t0} ms after the WebAuthn reply) - pressing`); device.press(1); }, () => {});
        },
      }).catch((e) => {
        /* only a press that went in and was not taken is the bug; any other refusal is the test's own */
        throw new Error(pressedAt
          ? `pressed ${pressedAt - t0} ms after the WebAuthn reply, and the certification never came: ${e.message} - the press was dropped while the reply was held`
          : `the certification was refused before any press: ${e.message}`);
      });
      const after = (await usb.head()).seq;
      assert.equal(after, before === null || before === SEQ_NONE ? 0 : before + 1, 'the pressed certification did not write exactly one link');
    } finally {
      for (const a of [app, usbApp]) { try { if (a.destroy) await a.destroy(); } catch { /* the test's verdict stands */ } }
    }
  });
});
