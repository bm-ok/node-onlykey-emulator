'use strict';
const shared = require('./_shared');

/**
 * v2.1.0 - the furthest back ok-versions.json goes, and therefore the release
 * that decides how far the version matrix can reach at all.
 *
 * Worth staging EARLY rather than last: if the oldest release builds, the ones
 * between it and the working tree are very unlikely to be harder, and the whole
 * matrix is reachable. If it does not, the failure names the boundary.
 *
 * No Profile_Offset patch - measured uint8_t in both places at 8687474, same
 * as v2.1.1.
 */
module.exports = {
  version: 'v2.1.0',
  pins: { libraries: '8687474', 'OnlyKey-Firmware': '159c0f2' },
  status: 'tested',
  emulator: { linux: 'boots', win32: 'boots' },   /* node-onlykey-emulator's own ladder: boots = matrix stage/build/press/compat PASS - linux (VM x64) and win32, 2026-09-27 */

  notes: [
    'PASSES AS PRODUCTION: 89 passed, 0 failed, 41 skipped - the highest of',
    'any pinned release. The furthest-back 2.x works, so the whole matrix is',
    'reachable.',
    '',
    'Its own sources ship with the DEBUG gate ON, one of five pins out of nine',
    'that do. That does not make a debug build the right thing to measure:',
    'the signed image declares v2.1.0-prod, so what went to users had the gate',
    'OFF, and the tags simply do not match the shipped build state.',
    '',
    'IT PRINTS ON A PRODUCTION BUILD, and that is upstream. v2.1.1 is the',
    'commit that wrapped those calls in #ifdef DEBUG - prints like',
    '"Generating Yubico OTP..." were bare before it - so turning the gate off',
    'never silenced them, and they shipped. 12-identity names this release as',
    'a known exception rather than relaxing its assertion, so the matrix',
    'reports the behaviour instead of hiding it. See',
    'ok-rn/FINDING-v2.1.0-prints-to-the-console-on-a-production-build.md',
    '',
    'The old note here said "RUNS AND FULLY PASSES: 67 of 67", which was a',
    'debug-era number from before the matrix built releases as they ship.',
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
    /*
     * EEPROM setters handed a null pointer - fatal hosted. See _shared.js.
     * NO hmac_challengemode and NO wipe_slot entries: both were measured
     * absent at 8687474 by version-probe.js. This release has the sketch and
     * timeout sites and nothing else.
     */
    ...shared.nullSetterPointers,
  ],

  /* Applied because a release ships with the DEBUG gate OFF - see _shared.js. */
  debugOffPatches: [shared.okconnectBufferGuard],
};
