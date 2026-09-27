'use strict';
const shared = require('./_shared');

/**
 * v2.1.1 - the older generation. Expect more trouble here than in the 3.0 line;
 * this is where the library's version branches actually differ.
 *
 * NO Profile_Offset patch, and that is measured rather than assumed:
 * `git show 0dc7cf0:password/password.cpp` declares the extern `uint8_t` in
 * BOTH places. The disagreement that breaks the 3.0 line was introduced after
 * this release, so applying the patch here would find no pattern and fail -
 * correctly.
 */
module.exports = {
  version: 'v2.1.1',
  pins: { libraries: '0dc7cf0', 'OnlyKey-Firmware': '0fe8d3a' },
  status: 'tested',
  emulator: { linux: 'boots', win32: 'boots' },   /* node-onlykey-emulator's own ladder: boots = matrix stage/build/press/compat PASS - linux (VM x64) and win32, 2026-09-27 */

  notes: [
    'RUNS AND FULLY PASSES: 67 of 67, staged as the STANDARD edition - see the',
    'gates note below, because the pinned commit is the travel one and staged',
    'as pinned this release cannot even be given a PIN.',
    '',
    'Ships with the DEBUG gate off, so OKEMU_DEBUG=1 is required as it is for',
    'the whole 3.0 line.',
    '',
    'Shares v2.1.0s generation behaviour: a press-required derive BLOCKS for',
    'five seconds with no keepalive and then denies, so a host must press on a',
    'timer (capabilities().presenceTest, FINDING #36).',
  ].join(String.fromCharCode(10)),

  /*
   * THIS COMMIT IS THE TRAVEL EDITION, and that is not a small difference.
   *
   * `git show 0dc7cf0:onlykey/onlykey.h` has BOTH build options commented out:
   *
   *     //#define DEBUG //Enable Serial Monitor
   *     //#define STD_VERSION //Define for STD edition firmare, undefine for IN TRVL edition firmware
   *
   * Every other pin in ok-versions.json is the standard edition. STD_VERSION
   * gates set_private's body, U2Finit and the encrypted profile itself, so
   * without it `profilemode` is NONENCRYPTEDPROFILE and most of the device's
   * own code returns early - staged as pinned, this release cannot even be
   * given a PIN, because the per-digit prompts the bracket waits for are inside
   * that gate.
   *
   * So it is staged as STANDARD, to be comparable with the other four. That
   * flips a switch the firmware itself provides, in the throwaway copy, exactly
   * as OKEMU_DEBUG=1 does - and it is recorded here so that nobody reads a
   * standard result and concludes the commit was standard. Whether the released
   * v2.1.1 binary was standard or travel is not something this repository can
   * answer; the COMMIT is travel.
   *
   * `OKEMU_STD=0` still builds it as pinned, for anyone who wants to measure
   * the travel edition on purpose - nothing else in the matrix covers it.
   */
  gates: { std: true },

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
    /* EEPROM setters handed a null pointer - fatal hosted. See _shared.js. */
    ...shared.nullSetterPointers,
    shared.wipeSlotNullSetters,
    shared.hmacChallengeModeNullSetter,
  ],

  /* Applied because a release ships with the DEBUG gate OFF - see _shared.js. */
  debugOffPatches: [shared.okconnectBufferGuard],
};
