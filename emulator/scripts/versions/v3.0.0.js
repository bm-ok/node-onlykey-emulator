'use strict';
const shared = require('./_shared');

/**
 * v3.0.0 - the first of the 3.0 line, and the interesting one for the version
 * matrix: node-onlykey-lib/src/device/version.js draws its capability boundary
 * between the 2.1 and 3.0 generations, so this release and v2.1.2 are the pair
 * that decides whether those branches are right.
 *
 * IT WAS NEVER SIGNED. 3.0.0 went out as an unsigned beta and was skipped for
 * production, so there is no `Signed_OnlyKey_3_0_0_STD` and there is not going
 * to be one. `ok-versions.json` carries no `file` for this row because of that,
 * and it is the only row without one.
 *
 * The pins are still exact: both are the upstream release tags - `libraries`
 * v3.0.0-prod is 5515974 and OnlyKey-Firmware's is dc24867. So the absent
 * image costs nothing here. What it does mean is that this is the one release
 * whose behaviour cannot be checked against a shipped binary, and the only
 * thing measured against it is what this matrix measures itself.
 */
module.exports = {
  version: 'v3.0.0',
  pins: { libraries: '5515974', 'OnlyKey-Firmware': 'dc24867' },
  status: 'tested',
  emulator: { linux: 'untried', win32: 'untried' },   /* node-onlykey-emulator's own ladder */

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
