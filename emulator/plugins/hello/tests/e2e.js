/**
 * hello's on-device tests (ok-rn e2e), SIDE-LOADED: they live in the plugin's
 * folder and leave with it. ok-rn's stager copies the staged plugins' tests into
 * src/generated/ (OKEMU_PLUGINS=hello OKEMU_PLUGINS_DIR=<this emulator>/plugins),
 * and the softKeyPlugins suite runs them - so they only ever run against a soft
 * key that has this plugin.
 *
 * Everything from the app comes in through `ctx` (no relative imports into
 * ok-rn): getOnlyKey, OkEmu, IFACE, protocol, pressDigits, PIN.
 */
'use strict';

const OKHELLO = 0x80 | 0x7e;

module.exports = function register({it}, ctx) {
  it('hello: OKHELLO is answered by the plugin, while unlocked', async ({log, assert}) => {
    if (!ctx.OkEmu.isRunning()) await ctx.OkEmu.start();
    const {device, transport} = await ctx.getOnlyKey();
    const state = await device.connect();
    if (!/UNLOCKED/i.test(String(state.status))) {
      await device.unlock(ctx.PIN, {timeoutMs: 20000, enterDigits: ctx.pressDigits({log})});
      await device.connect();
    }
    const reply = await transport.request({
      iface: ctx.IFACE.VENDOR,
      data: ctx.protocol.okmsg.build({msg: OKHELLO, slot: 0}),
      timeoutMs: 6000,
      match: r => /HELLO|Error/.test(ctx.protocol.okmsg.text(r)),
    });
    const said = ctx.protocol.okmsg.text(reply).trim();
    log(`the soft key said: ${JSON.stringify(said)}`);
    assert.equal(said, 'HELLO from plugin hello');
  });
};
