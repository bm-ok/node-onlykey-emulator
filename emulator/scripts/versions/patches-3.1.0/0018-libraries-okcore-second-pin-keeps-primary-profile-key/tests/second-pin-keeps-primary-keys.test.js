'use strict';
/*
 * 0018: adding a second-profile PIN in config mode keeps the primary profile's keys.
 *
 * One profile key encrypts both profiles' slots and keys. It is stored wrapped under a hash of the nonce2 mask, the chip
 * ID, a Curve25519 shared secret and the nonce. Which shared secret the unlock uses is chosen by the second-profile mode
 * byte: STDPROFILE2 - primary PIN key x second PIN key; otherwise - primary x primary (one profile).
 *
 * Setting the second PIN (okcore.cpp okcore_flashset_2ndpinhashpublic) re-wraps the profile key under the two-PIN
 * secret every time, but records STDPROFILE2 only on a key's first setup (`if (!initcheck)`). A key set up with its
 * primary PIN alone, given a second PIN later in config mode, keeps the one-profile mode byte: the next unlock with the
 * primary PIN checks out (the PIN hash does not involve the profile key) and unwraps the profile key with the wrong
 * secret. Every key it protects - the derivation keys, the slots - is then read as something else.
 *
 * The test: a blank key gets its primary PIN only, restarts, unlocks and derives a P-256 public key (DERIVE_PUBLIC_KEY
 * from slot 128's key - public data, no press). Config mode, the second-profile PIN set, a restart, the primary PIN
 * again and the same derive. 3.1.0: the derive is refused PIN_BLOCKED (the FIDO2 state is stored under the profile key
 * as well) or derives a different key - FAIL. With 0018: the same key - PASS.
 *
 * Standalone, run by the kit from this folder on a soft key built with the fixes to judge, DEBUG (the PIN steps wait on
 * the firmware's console):
 *   OKEMU_ROOT=<emulator built with the fixes to judge> node bin/okt.js run <this file>
 */
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const KIT = process.env.OKT_KIT || path.join(os.homedir(), 'project/onlykey/onlykey-testing');
const { describe, it } = require(path.join(KIT, 'lib/harness'));
const { PINS } = require(path.join(KIT, 'lib/config'));
const { okmsg } = require(path.join(KIT, 'lib/device'));
const { Ctap2 } = require(path.join(KIT, 'lib/device/ctap2'));
const tunnel = require(path.join(KIT, 'lib/device/tunnel'));
const transit = require(path.join(KIT, 'lib/device/transit'));

const TOO_SHORT = /Error PIN is not between 7 - 10 digits/;
const MISMATCH = /Error PINs Don't Match/;
const DIGIT_ACK = /password appended with/gi;
const RP_ID = 'apps.crp.to';
const P256 = { wire: 1, size: 65 };
const DERIVE_PUBLIC_KEY = 1;

/* one PIN through the firmware's arm / store / confirm / commit steps, each waited on by its own console line */
async function setPin(device, kind, pin, signal) {
  const msg = okmsg.PIN_KIND[kind];
  const advance = async (label, patterns) => {
    device.log.clear();
    device.sendVendor({ msg });
    const hit = await device.log.waitForAny(patterns, { timeoutMs: 15000, signal });
    if (hit.key !== 'ok') throw new Error(`${kind} ${label}: the key said "${hit.match[0].trim()}"`);
  };
  const enterDigits = async () => {
    device.log.clear();
    device.pressLine(pin.split(''));
    await device.log.waitForCount(DIGIT_ACK, pin.length, { timeoutMs: 15000, signal });
  };
  await advance('arm', { ok: /Enter PIN/ });
  await enterDigits();
  await advance('store', { ok: /Storing PIN/, short: TOO_SHORT });
  await advance('arm-confirm', { ok: /Confirm PIN/ });
  await enterDigits();
  await advance('commit', { ok: /Both PINs Match/, mismatch: MISMATCH, short: TOO_SHORT });
}

/* DERIVE_PUBLIC_KEY: reply [transit pub(32) | "UNLOCKEDv..." + model byte + NUL | public key], in the clear */
async function derivePub(device, label, signal) {
  const ctap = new Ctap2(device, { signal });
  await ctap.init();
  const ours = transit.keypair();
  const tag = crypto.createHash('sha256').update(label, 'utf8').digest();
  const data = Buffer.concat([transit.connectPayload(ours.publicKey), tag]);
  const reply = await tunnel.send(ctap, {
    cmd: okmsg.MSG.OKCONNECT, opt1: DERIVE_PUBLIC_KEY, opt2: P256.wire, opt3: 0, data,
  }, { rpId: RP_ID, timeoutMs: 30000, signal });
  if (!reply || !reply.data) throw new Error(`derive: no answer (${reply && (reply.error || reply.status)})`);
  const nul = reply.data.indexOf(0, 32);
  if (nul < 0) throw new Error('derive: no model string in the reply');
  const key = reply.data.subarray(nul + 1, nul + 1 + P256.size);
  if (key.length !== P256.size) throw new Error(`derive: the key came back ${key.length} bytes, not ${P256.size}`);
  return Buffer.from(key);
}

async function restartLocked(device, signal) {
  await device.restart({ signal });
  const { state, raw } = await device.status({ signal });
  if (state !== 'locked') throw new Error(`after the restart the key reports ${state} (${raw}), expected locked`);
}

describe('0018: a second-profile PIN added in config mode keeps the primary profile\'s keys', {
  state: 'blank',
  requires: ['crypto'],
  timeoutMs: 300000,
}, () => {
  it('the primary profile derives the same key before and after the second PIN is added', async ({ device, assert, signal, log }) => {
    const { state, raw } = await device.status({ signal });
    assert.equal(state, 'uninitialized', `expected a blank key, got ${raw}`);

    /* set up with the primary PIN alone: one profile */
    await setPin(device, 'primary', PINS.primary, signal);
    await restartLocked(device, signal);
    await device.unlock(PINS.primary, { signal });
    const before = await derivePub(device, '0018 primary profile', signal);
    const other = await derivePub(device, '0018 another label', signal);
    log(`before: ${before.toString('hex').slice(0, 24)}...`);
    assert.control('a different label derives a different key, so the comparison below can tell keys apart', !before.equals(other));

    /* a second profile added later, in config mode */
    await device.enterConfigMode(PINS.primary, { signal });
    await setPin(device, 'secondary', PINS.secondary, signal);
    log('second-profile PIN committed in config mode');

    /* the primary profile again, after a restart */
    await restartLocked(device, signal);
    await device.unlock(PINS.primary, { signal });
    /*
     * The FIDO2 state (the PIN retries with it) is stored encrypted under the profile key too (okcore.cpp, the auth
     * state read): with the profile key unwrapped wrongly it decrypts to garbage and the key answers PIN_BLOCKED to the
     * derive - the same fault seen from FIDO2's side, said as such.
     */
    let after;
    try {
      after = await derivePub(device, '0018 primary profile', signal);
    } catch (e) {
      if (/PIN_BLOCKED/.test(String(e && e.message))) {
        assert.ok(false, 'after a second-profile PIN was added in config mode the primary profile\'s FIDO2 state reads as PIN blocked - it is stored under the profile key, which was unwrapped with the wrong secret');
      }
      throw e;
    }
    log(`after:  ${after.toString('hex').slice(0, 24)}...`);

    assert.bytes(after, before, 'the primary profile derives a different key after a second-profile PIN was added in config mode - its profile key was unwrapped with the wrong secret');
  });
});
