'use strict';

/**
 * The working tree - what stage.js builds when OKEMU_VERSION is unset.
 *
 * Not a release, and its own script for exactly that reason. Everything else
 * here is pinned to a commit in ok-versions.json; this one is whatever
 * OnlyKey-Firmware and libraries happen to be checked out at, which is the
 * generation ahead of the newest release. Without a script for it, every edit
 * the current sources need and no release does would have had to live in
 * stage.js as an unexplained special case.
 *
 * ## It keeps the unnamed storage slot
 *
 * `slot: ''`, so its flash.bin and eeprom.bin stay in files/okemu exactly where
 * they have always been. That is load-bearing rather than tidy: moving them
 * would strand the provisioned device on every phone that already has one, and
 * nothing re-provisions itself.
 *
 * ## DEBUG is ON here and OFF in every release
 *
 * onlykey.h:81 is `#define DEBUG` in this tree and `//#define DEBUG` at v3.0.2.
 * The difference is upstream's, not ours - somebody left the switch on while
 * working. It is why the soft key can be given a PIN at all by default, and why
 * a pinned release needs OKEMU_DEBUG=1 before it can be.
 */
const shared = require('./_shared');

module.exports = {
  version: 'working-tree',
  status: 'tested',
  emulator: { linux: 'tested', win32: 'tested' },   /* node-onlykey-emulator's own ladder */
  slot: '',
  /* The tree has onlykey/okpqc.cpp (the post-quantum code) - see stage.js
   * pinnedAbsent. Spread into v3.0.5 and v3.1.0, which are pinned AND have it. */
  hasOkpqc: true,

  notes: [
    'Whatever the checkouts are at. The full e2e suite runs against this.',
    'Since 2026-09-28 the checkouts are 3.1.0 (bm-ok masters), which ships',
    'DEBUG off; before that the tree shipped DEBUG on.',
  ].join('\n'),

  /**
   * NO PATCHES. The one that lived here is retired, and the reason it gave was
   * WRONG.
   *
   * It deleted `void yield(void) {}` from OnlyKey.ino, and its justification -
   * written here and in commit fe2aeb6 - claimed a no-op yield() "stops the
   * clock", because okemu_sync_systick() would never run and every delay() and
   * poll loop reaches time through it.
   *
   * THAT IS NOT TRUE. android/okemu/src/ok_hal.cpp:356 starts a dedicated
   * thread calling okemu_sync_systick() every 500 us - "the honest emulation of
   * a hardware timer interrupt" - written precisely because feeding the counter
   * from micros() froze payload()'s wait loop. micros() syncs it as well. The
   * clock runs whatever the sketch's yield() does.
   *
   * What the patch actually resolved was a LINK ERROR: core-override's
   * okemu_pins.cpp defined yield() strongly, so the sketch gaining its own
   * definition made two strong ones - "duplicate symbol: yield". A real
   * failure, for a reason stated incorrectly, and a false WHY is the thing
   * this codebase warns about hardest: it survives longer than the code and
   * teaches the next reader something untrue.
   *
   * It needs no patch now. okemu_pins.cpp marks its yield() WEAK, matching the
   * Teensy core's own linkage, so the sketch's definition wins where it exists
   * and the emulator's is used where it does not - the choice left with the
   * firmware, which is where it belongs. stage.js also drops core/yield.cpp,
   * whose weak definition would otherwise be a coin flip on any tree whose
   * sketch has no yield() (see the DROP entry).
   *
   * Retiring it also removes this project's only edit to OnlyKey.ino - the
   * file most likely to be reformatted upstream.
   */
  patches: [],

  /*
   * APPID_NULL_GUARD's line is gone, because UPSTREAM FIXED IT.
   *
   * That guard existed because webcryptcheck() compared a caller's `_appid`
   * against the trusted origin hashes without checking it for NULL, and
   * ctap.cpp's add_existing_user_info() passes NULL on every allowList
   * credential of every getAssertion. libraries@c1a6cf2 ("webcryptcheck(): do
   * not compare a NULL appid against the trusted hashes", 2026-09-22) rewrote
   * the whole comparison as
   *
   *     if (_appid && memcmp(trusted[t].hash, _appid, 32) == 0) origin_ok = 1;
   *     else if (memcmp(trusted[t].name, rpid, trusted[t].namelen) == 0) ...
   *
   * which is null-safe by construction and takes the same position ours did -
   * the name comparison is the answer on that path. `stored_appid`,
   * `appid_match1`, `appid_match2` and the per-origin variables are all gone
   * with it.
   *
   * Declared absent rather than dropped from the shared list, because every
   * PINNED release still has the old spelling and still needs the guard.
   * stage.js throws if this line ever comes back, so the claim cannot go stale
   * and leave the tree unpatched.
   */
  absentPatterns: [
    '	appid_match2 = memcmp (stored_appid, _appid, 32);',
  ],

  /**
   * NONE LEFT. Upstream fixed every defect this list guarded against.
   *
   * All three entries existed because webcryptcheck() and the OKCONNECT
   * dispatch branch dereferenced pointers their callers hand over as NULL, and
   * only the `#ifdef DEBUG` early return kept a debug build from noticing -
   * see FINDING-production-firmware-crashes-in-webcryptcheck.md. Between
   * libraries@8d77e34 and @7bd29a4 the maintainer closed all of them:
   *
   *   appid_match3 / stored_appid_oa   gone with the origin itself.
   *                                    libraries@e44ff6c drops onlyagent.app;
   *                                    the trusted origins are now a `trusted[]`
   *                                    table of apps.crp.to and apps.onlykey.io.
   *   okconnectBufferGuard...          the whole `buffer[4]==OKCONNECT` branch
   *                                    is out of fido2/device.cpp; OKCONNECT is
   *                                    handled on the raw-HID path instead.
   *   appid_match1 / stored_apprpid    libraries@c1a6cf2 rewrote the comparison
   *                                    as a null-safe loop over `trusted[]`.
   *                                    Declared below rather than deleted,
   *                                    because it lives in stage.js's SHARED
   *                                    list and every pinned release still
   *                                    needs it.
   *
   * Each was verified as fixed, not merely re-spelled, before being dropped. A
   * guard removed because its anchor moved would be a guard silently lost.
   */
  debugOffPatches: [],

  /**
   * See the note above: this one is stage.js's, so the working tree declares it
   * absent instead of deleting it. stage.js throws if it reappears.
   */
  debugOffAbsentPatterns: [
    '    appid_match1 = memcmp (stored_apprpid, rpid, 12);',
  ],
};
