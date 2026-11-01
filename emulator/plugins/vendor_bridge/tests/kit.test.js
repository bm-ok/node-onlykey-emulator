'use strict';
/*
 * vendor_bridge's emulator tests (the onlykey-testing kit), side-loaded: they leave with the plugin. Everything from the
 * kit comes in through `ctx`.
 *
 * The bridge's promise is that the vendor interface does what the CTAP tunnel does: so each test runs the tunnel's work
 * over the vendor bridge, and the bucket identity and bucket key are compared with the same work over the WebAuthn
 * tunnel (ctap_bridge's test path) - one key, one site, the same bytes.
 */
const OKVENDORBRIDGE = 0x80 | 0x7d;

module.exports = function register({ it }, ctx) {
  /* the lib over the kit's device, okcrypto's ctap = the vendor bridge on the lib's own transport (bound once started) */
  async function vendorApp() {
    const { createVendorBridgeCtap } = ctx.requireLib('node-onlykey-lib/src/protocol/vendor-bridge');
    const late = {};
    const ctap = { vendorBridge: true, getAssertion: (p, o) => late.ctap.getAssertion(p, o) };
    const app = await ctx.kit.libstack.composeLib(ctx.device, { config: { okcrypto: { ctap, rpIds: ['ok-edge.bmatusiak.workers.dev'] } } });
    late.ctap = createVendorBridgeCtap(app.services.transport, { timeoutMs: 60000 });
    return app;
  }
  /* the press for a derive: entered once the key has had a moment to start (derive_secret's tests) */
  const deriveOpts = (device, signal, log) => ({
    timeoutMs: 60000,
    confirm: async ({ digits }) => {
      log(`the code for the derive: ${digits.join(' ')}`);
      await device.sleep(1500, { signal });
      device.pressLine(digits);
    },
  });

  /*
   * LOCKED, THE KEY DOES NOT READ IT: the sketch calls recvmsg only while unlocked (OnlyKey.ino), so nothing of the
   * vendor interface - this message included - is dispatched before the PIN. (The plugin's own lock check is a second
   * guard.) No answer at all, and nothing of the tunnel's.
   */
  it('vendor_bridge: while locked the key does not read it - no answer', async ({ device, assert, signal }) => {
    await device.restart({ signal });
    const since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKVENDORBRIDGE, slot: 0x80, payload: Buffer.alloc(58) });
    await device.sleep(3000, { signal });
    const got = device.reportsSince(ctx.IFACE.VENDOR, since);
    assert.equal(got.filter((r) => r[0] === 0xfd).length, 0, 'a locked key answered the vendor bridge');
  });

  it('vendor_bridge: the bucket identity and bucket key over the vendor interface - the same bytes as over the WebAuthn tunnel', async ({ device, assert, signal, log }) => {
    ctx.device = device;
    await device.restart({ signal });
    await device.unlock(ctx.PINS.primary, { signal });
    const bid = ctx.requireLib('node-onlykey-lib/bucket').bucketIdentity;
    const hex = (b) => Buffer.from(b).toString('hex');

    /* over the vendor bridge */
    let viaVendor;
    const app = await vendorApp();
    try {
      const okcrypto = app.services.okcrypto;
      await okcrypto.connectTunnel();
      const { publicKey, id } = await bid.readIdentity(okcrypto);
      const site = 'ok-edge.bmatusiak.workers.dev';
      const bucketKey = await bid.deriveBucketKeyAt(okcrypto, publicKey, site, deriveOpts(device, signal, log));
      /* the certificate: the key signs the bucket key with the identity, pressed once its challenge is primed */
      const PRIMED = ctx.kit.pqc.PRIMED;
      const before = device.log.count(PRIMED);
      const certificate = await bid.certify(okcrypto, publicKey, bucketKey.publicKey, {
        timeoutMs: 60000,
        confirm: async ({ digits }) => {
          log(`the code for the certificate: ${digits.join(' ')}`);
          await device.log.waitForCount(PRIMED, before + 1, { timeoutMs: 60000, signal, pending: device.pending });
          device.pressLine(digits);
        },
      });
      assert.ok(bid.verifyCertificate({ identityPublicKey: publicKey, bucketPublicKey: bucketKey.publicKey, certificate }),
        'the certificate signed over the vendor bridge does not verify');
      viaVendor = { id, bucket: hex(bucketKey.publicKey) };
      log(`vendor bridge: identity ${id.slice(0, 12)}, bucket key ${viaVendor.bucket.slice(0, 16)}, certificate verified`);
    } finally {
      await app.destroy();
    }

    /* the same over the WebAuthn tunnel (ctap_bridge's path) */
    const Rectify = ctx.requireLib('@bmatusiak/rectify');
    const plugins = ['host', 'transport/tunnel', 'session', 'device', 'okcrypto'].map((p) => ctx.requireLib(`node-onlykey-lib/plugins/${p}`));
    const { createWebAuthnCtap } = ctx.requireLib('node-onlykey-lib/transport/webauthn');
    const { window } = ctx.kit.webenv.create(device, { signal });
    plugins.config = { okcrypto: { ctap: createWebAuthnCtap({ credentials: window.navigator.credentials }) } };
    const web = await new Promise((resolve, reject) => {
      const a = Rectify.build(plugins, (err, started) => (err ? reject(err) : resolve(started)));
      a.start();
    });
    try {
      const okcrypto = web.services.okcrypto;
      await okcrypto.connectTunnel();
      const { publicKey, id } = await bid.readIdentity(okcrypto);
      const { site } = await okcrypto.keySite();
      const bucketKey = await bid.deriveBucketKeyAt(okcrypto, publicKey, site, deriveOpts(device, signal, log));
      log(`WebAuthn tunnel: identity ${id.slice(0, 12)}, bucket key ${hex(bucketKey.publicKey).slice(0, 16)}`);
      assert.equal(id, viaVendor.id, 'the bucket identity differs between the vendor bridge and the WebAuthn tunnel');
      assert.equal(hex(bucketKey.publicKey), viaVendor.bucket, 'the bucket key differs between the vendor bridge and the WebAuthn tunnel');
    } finally {
      await web.destroy();
    }
  });
};
