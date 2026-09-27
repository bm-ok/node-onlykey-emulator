'use strict';
const shared = require('./_shared');

/**
 * v3.0.1 - same generation as v3.0.2, one release back.
 *
 * Probed only. version-probe.js reports 8/8 version-pinned patterns matching,
 * and `git show a27ffa6:password/password.cpp` has the same `int`/`uint8_t`
 * disagreement the 3.0 line carries throughout, so it takes the same shared
 * patch. Neither of those is a build.
 */
module.exports = {
  version: 'v3.0.1',
  pins: { libraries: 'a27ffa6', 'OnlyKey-Firmware': 'c3929eb' },
  status: 'tested',
  emulator: { linux: 'boots', win32: 'boots' },   /* node-onlykey-emulator's own ladder: boots = matrix stage/build/press/compat PASS - linux (VM x64) and win32, 2026-09-27 */

  notes: [
    'RUNS AND FULLY PASSES: 67 of 67, with no patches beyond the ones the 3.0',
    'line shares. Nothing release-specific was needed.',
    '',
    'Ships with the DEBUG gate off like every release, so OKEMU_DEBUG=1 is',
    'required before it can be provisioned.',
    '',
    'Has the touch-free derive gate that v3.0.2 reads from a stale cache? NO -',
    'the check arrived IN v3.0.2. Here the touch-free derive is unconditional,',
    'which is what capabilities().touchFreeDerive reports as "always".',
  ].join(String.fromCharCode(10)),

  patches: [
    /* The 64-bit flash stride - without this the PIN never matches. */
    shared.flashWalkStride,
    /* Replies dropped when the TX queue is busy - one request after another. */
    shared.droppedTransportResponse,
    /* HW_MODEL returned a pointer into its own dead frame. */
    shared.hwModelStackBuffer,
    /* Non-void functions falling off the end - one hangs FIDO2 registration. */
    ...shared.missingReturns,
    /* byteprint() reads through a null argument on a DEBUG build. */
    shared.byteprintNullArgument,
    /* The FULLWIPE debug dump starts at page zero, which is unmapped. */
    shared.pageZeroDebugDump,
    shared.profileOffsetType,
    /*
     * EEPROM setters handed a null pointer. Fatal hosted, and the
     * failedlogins one is on the successful-login path - without this the
     * device cannot be unlocked at all. See _shared.js.
     */
    ...shared.nullSetterPointers,
    shared.wipeSlotNullSetters,
    shared.hmacChallengeModeNullSetter,
  ],

  /* Applied because a release ships with the DEBUG gate OFF - see _shared.js. */
  debugOffPatches: [shared.okconnectBufferGuard],
};
