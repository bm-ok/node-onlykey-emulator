'use strict';
const shared = require('./_shared');

/**
 * v3.0.2 - the newest release in ok-versions.json, and the first old version
 * taken all the way to a running, tested device.
 *
 * Every one of stage.js's shared patterns still matches here, so the 3.0 line
 * looked like a short job. It was not: this release needs THIRTEEN patches of
 * its own before it will run hosted, and each one was a defect present in the
 * shipped firmware that has been fixed upstream since. They are all in
 * _shared.js, with the measurement that found each.
 *
 * The one that mattered most is flashWalkStride. `unsigned long` is 8 bytes on
 * arm64 and 4 on the Teensy, so flash was walked at twice the stride of the
 * byte buffer beside it - and since the PIN hash goes through that path, a
 * CORRECT PIN read back as wrong. It is invisible on a 32-bit handset, which
 * is what the bench device happens to be.
 *
 * ## BOTH PINS ARE THE UPSTREAM RELEASE TAGS
 *
 * `libraries` tag v3.0.2-prod is 5d7ce7a and OnlyKey-Firmware's is 7671d6f -
 * exactly what is pinned. Confirmed through the GitHub API; the local
 * checkouts are forks and carry no tags of their own.
 *
 * This is worth stating because the pin LOOKS wrong. Three commits declare
 * 3.0.2 and this is the first of them: 5d7ce7a "testing 3.0.2" (2022-08-31),
 * then e80e7c6 and 5495501 (both 2022-10-25). A guess written here earlier
 * said the pin should move to the last of the three, by analogy with v3.0.0
 * and v3.0.1.
 *
 * The release date is what explains it. v3.0.2 was published on 2022-10-05 and
 * those two later commits landed three weeks AFTER it - they carry the 3.0.2
 * version number only because the macro is not bumped until the next cycle
 * starts. They were never in this release, and repinning to them would have
 * quietly replaced a measured release with a tree nobody received.
 */
module.exports = {
  version: 'v3.0.2',
  pins: { libraries: '5d7ce7a', 'OnlyKey-Firmware': '7671d6f' },
  status: 'tested',
  emulator: { linux: 'boots', win32: 'boots' },   /* node-onlykey-emulator's own ladder: boots = matrix stage/build/press/compat PASS - linux (VM x64) and win32, 2026-09-27 */

  notes: [
    'RUNS AND FULLY PASSES: 67 of 67 e2e tests, on a device this suite',
    'provisioned itself (0-provision sets the PIN, 9-cryptoSign the signing key',
    'and the touch-free derive preference).',
    '',
    'Stage it with OKEMU_DEBUG=1 or it cannot be provisioned at all: a RELEASE',
    'ships with the DEBUG gate off and the PIN bracket is a conversation held',
    'entirely in Serial.println (FINDING-provisioning-needs-a-debug-build.md).',
    '',
    'Fifteen hosting fixes were needed, all present in the release and all',
    'fixed upstream since - see _shared.js for the measurement behind each.',
    'The one that mattered most was the 64-bit flash stride: it made a correct',
    'PIN read back as wrong, and it is invisible on a 32-bit handset.',
    '',
    'TWO THINGS THIS FIRMWARE GENUINELY CANNOT DO, and the library now knows:',
    '  * the touch-free derive. v3.0.2 ADDED the preference check and read it',
    '    from a RAM cache its own raw-HID path clears, so it refuses a setting',
    '    it is holding. v3.0.1 and earlier have no check at all. Not patched:',
    '    a real v3.0.2 key behaves this way and the app has to handle it.',
    '  * X-Wing, and the age format built on it. KEYTYPE_XWING appears nowhere',
    '    at 5d7ce7a. An old device does not refuse the request - it answers',
    '    with a valid status and no key - so the library refuses it instead.',
    '',
    'Both are capabilities in node-onlykey-lib/src/device/version.js, and the',
    'suite asserts the REFUSAL on this version rather than success.',
    '',
    '2026-09-24 sweep: cryptoSign failed runs 1-2 with "incorrect challenge"',
    '("pressed 1-6 of 1-6-6"), passed run 3. Not this firmware - the soft',
    'key returned a vendor write when the frame was QUEUED, so a challenge',
    'press could be taken before the request armed it. Fixed in okemu',
    '(ok_hal.cpp: a vendor write waits until the firmware takes the frame);',
    'cryptoSign 8/8 on this build afterwards, working tree 104/0/34.',
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
  debugOffPatches: [shared.okconnectBufferGuardWithChallengeMode],

  /**
   * The staged tree AS THIS RELEASE SHIPS - no gate override. OKEMU_DEBUG=1
   * and OKEMU_PRODUCTION=1 both change four files, so the comparison is
   * skipped when either is set rather than reporting a change every time.
   */
  expect: { digest: '1a6eecece6fe' },
};
