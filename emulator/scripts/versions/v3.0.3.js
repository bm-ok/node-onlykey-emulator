'use strict';
const shared = require('./_shared');

/**
 * v3.0.3 - one cycle on from v3.0.2, and the first release with no libraries
 * tag to pin it by.
 *
 * OnlyKey-Firmware tags v3.0.3-prod at 9600daa, which is also where
 * v3.0.4-prod points: the sketch did not change between the two releases, so
 * everything that distinguishes them is on the libraries side.
 *
 * And the libraries repository stops tagging at v3.0.2-prod. So this pin is
 * derived rather than read, by the rule in versions/index.js - the last commit
 * declaring the version at or before the release date. v3.0.3 was published on
 * 2022-11-08; a133bea "testing release" is 2022-11-04; the next commit
 * declaring 3.0.3 is 9c99922 on 2022-11-26, which is after the release and
 * therefore cannot be in it. That rule reproduces all seven tagged libraries
 * pins, which is the only reason to trust it here.
 *
 * The patch list starts as v3.0.2's, because that is the nearest measured
 * neighbour and a133bea is two commits later. Every entry is mandatory - a
 * pattern that does not match is an error, not a shrug - so the first stage
 * run says which of these this tree no longer needs, and `absentPatterns` is
 * where a deliberate gap gets declared.
 */
module.exports = {
  version: 'v3.0.3',
  pins: { libraries: 'a133bea', 'OnlyKey-Firmware': '9600daa' },
  status: 'tested',
  emulator: { linux: 'untried', win32: 'untried' },   /* node-onlykey-emulator's own ladder */

  notes: [
    'PASSES AS PRODUCTION once the library stopped claiming features this',
    'release does not have. Swept 2026-09-12: 56 passed, 2 failed, 10 skipped before the fix.',
    '',
    'It boots, completes OKCONNECT, takes a PIN, unlocks, types slots, loads',
    'and uses a signing key, and answers CTAPHID.',
    '',
    'EVERY FAILURE THIS RELEASE EVER REPORTED WAS THE LIBRARY, NOT THE',
    'FIRMWARE. Three capability fields in version.js were written one release',
    'ahead of anything anyone had run, and this is the release they guessed',
    'at:',
    '',
    '  touchFreeDerive  claimed "preference", measured BROKEN',
    '  postQuantum      claimed true from v3.0.3, measured FALSE',
    '  xwingDerive      claimed true from v3.0.3, measured FALSE - the last',
    '                   of the three, and it survived the first fix because',
    '                   nothing had run its tests against a release until the',
    '                   whole matrix was swept as production',
    '',
    'All three are now the DEVELOPMENT LINE rather than a version threshold.',
    'Measured by diff, not by guess: KEYTYPE_XWING, mlkem, okpqc and the whole',
    'ML-KEM/ML-DSA tree exist at HEAD and at no pinned release. And there was',
    'never a boundary here to sit on - v3.0.2 to v3.0.3 is 29 lines of libraries and 27 of firmware.',
    'ok-rn/FINDING-capability-guesses-about-the-next-release-were-wrong.md',
    '',
    'ITS OWN SOURCES SHIP WITH DEBUG ON. This release turns //#define DEBUG',
    'into #define DEBUG in both OnlyKey.ino and onlykey.h, so the recorded',
    'digest is taken from a PRODUCTION stage rather than from the tree as',
    'committed. matrix.js builds it as production by default and does one',
    'debug build when a first PIN is needed, so nothing here needs',
    'OKEMU_DEBUG=1 by hand any more.',
  ].join(String.fromCharCode(10)),

  /* v3.0.2's list. Every one still applies here - measured, not assumed. */
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

  /*
   * Kept from v3.0.2, and INERT here: these sources carry the DEBUG gate ON
   * already, where v3.0.2's have it off. Upstream left it enabled in the
   * committed source after 3.0.2 and turned it off when building the
   * release - the signed image declares -prod, which is that gate being
   * off. Listed anyway so a later release shipping with it off is covered
   * without anyone having to notice.
   */
  debugOffPatches: [shared.okconnectBufferGuardWithChallengeMode],

  /*
   * The release AS IT SHIPS, which is a production build.
   *
   * First recorded from a plain stage.js, which for these two leaves the
   * DEBUG gate ON - their committed sources carry it, unlike v3.0.2's. That
   * digest described a tree nobody receives: the signed image declares
   * -prod, so the release was built with the gate off. Re-recorded from
   * OKEMU_PRODUCTION=1, and the check now compares whenever the gate ends
   * up off however it got there.
   */
  expect: { digest: '7c78b00dc10b' },
};
