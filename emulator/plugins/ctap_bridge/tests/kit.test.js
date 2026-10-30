'use strict';
/*
 * ctap_bridge's emulator tests (the onlykey-testing kit), side-loaded: they leave with the plugin. Everything from
 * the kit comes in through `ctx` (IFACE, okmsg, PINS).
 */
const OKCTAPBRIDGE = 0x80 | 0x7b;
module.exports = function register({ it }, ctx) {
  it('ctap_bridge: on and the default site while unset; a change outside config mode is refused', async ({ device, assert, signal, log }) => {
    await device.restart({ signal });
    await device.unlock(ctx.PINS.primary, { signal });
    let since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKCTAPBRIDGE, slot: 0 });
    let reply = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /ctap_bridge|Error/, timeoutMs: 6000, signal });
    const state = ctx.okmsg.text(reply).trim();
    log(`report: ${JSON.stringify(state)}`);
    assert.equal(state, 'ctap_bridge on site ok-edge.bmatusiak.workers.dev');
    since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKCTAPBRIDGE, slot: 2 });
    reply = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /ctap_bridge|Error/, timeoutMs: 6000, signal });
    assert.equal(ctx.okmsg.text(reply).trim(), 'Error not in config mode');
  });

  /*
   * THE KEY'S SITE OVER THE TUNNEL (the server it belongs to, okcrypto.keySite): a page reads the same report a USB
   * host reads - one answer, two ways.
   */
  it('ctap_bridge: its report over the tunnel - the key\'s site, as over USB', async ({ device, assert, signal, log }) => {
    await device.restart({ signal });
    await device.unlock(ctx.PINS.primary, { signal });
    const since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKCTAPBRIDGE, slot: 0 });
    const usb = ctx.okmsg.text(await device.waitHid(ctx.IFACE.VENDOR, { since, match: /ctap_bridge|Error/, timeoutMs: 6000, signal })).trim();
    const Rectify = ctx.requireLib('@bmatusiak/rectify');
    const plugins = ['host', 'transport/tunnel', 'session', 'device', 'okcrypto']
      .map((p) => ctx.requireLib(`node-onlykey-lib/plugins/${p}`));
    const { createWebAuthnCtap } = ctx.requireLib('node-onlykey-lib/transport/webauthn');
    const { window } = ctx.kit.webenv.create(device, { signal });
    plugins.config = { okcrypto: { ctap: createWebAuthnCtap({ credentials: window.navigator.credentials }) } };
    const app = await new Promise((resolve, reject) => {
      const a = Rectify.build(plugins, (err, started) => (err ? reject(err) : resolve(started)));
      a.start();
    });
    let site;
    try {
      await app.services.okcrypto.connectTunnel();
      site = await app.services.okcrypto.keySite();
    } finally {
      await app.destroy();
    }
    log(`USB: ${JSON.stringify(usb)}; tunnel: ${JSON.stringify(site)}`);
    assert.equal(site.on, true, 'the tunnel report: on');
    assert.equal(site.site, 'ok-edge.bmatusiak.workers.dev', 'the tunnel report: the default site');
    assert.equal(usb, `ctap_bridge on site ${site.site}`, 'the USB report says the same');
  });

  /*
   * WHAT THE WEB APP DOES FOR ITS BUCKET KEY (ok-edge src/bucketTrade.ts), over the WebAuthn tunnel alone - the lib
   * composed as a page composes it (kit lib/webenv.js): the bucket identity (agent public key, no press), the bucket
   * key (agent X25519 ECDH) and its certificate (agent Ed25519 sign), each answered with the code the lib works out
   * from the bytes it sent - the code the web app shows. The certificate must verify.
   */
  it('ctap_bridge: the bucket key over the tunnel - agent public key, the derive under the site the key names and sign, each with its code', async ({ device, assert, signal, log }) => {
    await device.restart({ signal });
    await device.unlock(ctx.PINS.primary, { signal });
    const Rectify = ctx.requireLib('@bmatusiak/rectify');
    const plugins = ['host', 'transport/tunnel', 'session', 'device', 'okcrypto']
      .map((p) => ctx.requireLib(`node-onlykey-lib/plugins/${p}`));
    const { createWebAuthnCtap } = ctx.requireLib('node-onlykey-lib/transport/webauthn');
    const { window } = ctx.kit.webenv.create(device, { signal });
    plugins.config = { okcrypto: { ctap: createWebAuthnCtap({ credentials: window.navigator.credentials }) } };
    const app = await new Promise((resolve, reject) => {
      const a = Rectify.build(plugins, (err, started) => (err ? reject(err) : resolve(started)));
      a.start();
    });
    try {
      const okcrypto = app.services.okcrypto;
      await okcrypto.connectTunnel();
      const bid = ctx.requireLib('node-onlykey-lib/bucket').bucketIdentity;
      const { publicKey, id } = await bid.readIdentity(okcrypto);
      log(`bucket identity ${id.slice(0, 12)} (agent public key over the tunnel)`);

      /* the code: pressed once the key has primed its challenge (counted before each ask: it may prime first) */
      const PRIMED = ctx.kit.pqc.PRIMED;
      let before = device.log.count(PRIMED);
      const confirm = async ({ digits }) => {
        log(`the code the host shows: ${digits.join(' ')}`);
        await device.log.waitForCount(PRIMED, before + 1, { timeoutMs: 60000, signal, pending: device.pending });
        device.pressLine(digits);
      };
      const opts = { confirm, timeoutMs: 60000 };
      /* the bucket key (v2): derive_secret's derive of the identity's label under the site this key names, over the tunnel */
      const { site } = await okcrypto.keySite();
      const bucketKey = await bid.deriveBucketKeyAt(okcrypto, publicKey, site, opts);
      const hex = (b) => Buffer.from(b).toString('hex');
      log(`bucket key made (derive_secret under ${site}, over the tunnel): public ${hex(bucketKey.publicKey).slice(0, 16)}`);
      before = device.log.count(PRIMED);
      const certificate = await bid.certify(okcrypto, publicKey, bucketKey.publicKey, opts);
      assert.ok(bid.verifyCertificate({ identityPublicKey: publicKey, bucketPublicKey: bucketKey.publicKey, certificate }),
        'the certificate the key signed over the tunnel does not verify');
    } finally {
      await app.destroy();
    }
  });
};
