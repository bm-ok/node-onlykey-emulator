'use strict';
/*
 * hello's emulator tests (the onlykey-testing kit), SIDE-LOADED: they live in
 * the plugin's folder and leave with it. node-onlykey-emulator records the
 * staged plugins and their folder in .stage/build.json; the kit's
 * 01-protocol/38-softkey-plugins.test.js reads that and registers each
 * plugin's tests - so they only ever run against an emulator built with it.
 *
 * Everything from the kit comes in through `ctx` (no relative imports into
 * the kit): IFACE, okmsg, PINS.
 */
const OKHELLO = 0x80 | 0x7e;

module.exports = function register({ it }, ctx) {
  it('hello: OKHELLO is answered while unlocked, and not while locked',
    async ({ device, assert, signal, log }) => {
      await device.restart({ signal });

      /* locked: like every vendor message, nothing comes back */
      const lockedSince = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: OKHELLO, slot: 0 });
      await device.sleep(1500, { signal });
      const lockedSaid = device.reportsSince(ctx.IFACE.VENDOR, lockedSince)
        .map((r) => ctx.okmsg.text(r).trim()).filter((t) => /HELLO/.test(t));
      assert.equal(lockedSaid.length, 0, `a locked key answered OKHELLO: ${lockedSaid[0]}`);

      await device.unlock(ctx.PINS.primary, { signal });
      const since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: OKHELLO, slot: 0 });
      const reply = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /HELLO/, timeoutMs: 6000, signal });
      const said = ctx.okmsg.text(reply).trim();
      log(`the emulator said: ${JSON.stringify(said)}`);
      assert.equal(said, 'HELLO from plugin hello');
    });
};
