'use strict';
const shared = require('./_shared');

/**
 * v2.1.2 - the pin was right all along, and it was on a BRANCH.
 *
 * ok-versions.json pins libraries@12eb5b0, and for most of this project's life
 * `git cat-file -e` failed on it, so nothing about this release could be
 * measured: not the patches, not a build, not a boot.
 *
 * The pin was never wrong. Upstream tags its releases, and `libraries` tag
 * `v2.1.2-prod` points at exactly 12eb5b0. The local checkouts are FORKS of
 * master with no tags, which is why it took the GitHub API to see it, and the
 * release was cut from the branch `remove-touchsense` rather than from master
 * - which is the whole reason a fork of master does not carry the commit.
 *
 * This file briefly said something else. It was repinned to `8f74eac` on the
 * reasoning that 12eb5b0 "is not one of the three commits that declare 2.1.2"
 * and that the pin should be the last commit of that range. Both halves were
 * wrong: the range rule was a guess read off three rows that happened to
 * agree, and the tags settle it directly. The pin is back to what it was.
 *
 * UNBLOCKED 2026-09-12, with the user's word, by fetching the branch upstream
 * cut it from. The fork's `origin` is bm-ok/0c-coder-libraries; the original
 * is trustcrypto, so that went in as a second remote:
 *
 *     git -C ../libraries remote add trustcrypto https://github.com/trustcrypto/libraries
 *     git -C ../libraries fetch trustcrypto remove-touchsense
 *
 * Objects only. `libraries` stayed on master with a clean working tree, which
 * is what makes this compatible with it being a read-only reference checkout.
 * `OnlyKey-Firmware@bbb910a` was already present and also matches its tag.
 */
module.exports = {
  version: 'v2.1.2',
  pins: { libraries: '12eb5b0', 'OnlyKey-Firmware': 'bbb910a' },
  status: 'tested',
  emulator: { linux: 'boots', win32: 'boots' },   /* node-onlykey-emulator's own ladder: boots = matrix stage/build/press/compat PASS - linux (VM x64) and win32, 2026-09-27 */

  notes: [
    'The pin is confirmed correct: upstream tag v2.1.2-prod IS 12eb5b0. The',
    'release was cut from the branch remove-touchsense rather than master, so',
    'a fork of master did not have it. Fetched from the trustcrypto remote on',
    '2026-09-12 and the commit now resolves.',
    '',
    'SWEPT AS PRODUCTION: 87 passed, 0 failed, 43 skipped. Blocked for the',
    'whole life of this project and green in one day.',
    '',
    'It needs v2.1.1\'s patch list and NOTHING ELSE. This file carried',
    'patches: [] for a while, on the reasoning that copying that list "would',
    'record a measurement nobody made" - and that caution was the bug. Without',
    'flashWalkStride the firmware walks flash with an 8-byte pointer on a',
    '64-bit host, so every other 32-bit word of the PIN hash and the nonce is',
    'never written. Read out of flash.bin after a provision: nonce word 0 at',
    '+0, four bytes of 0xFF, nonce word 1 at +8. The device stored a PIN',
    'through its own bracket and then refused it, which cost most of a day.',
    'See ok-rn/FINDING-v2.1.2-sets-a-pin-it-will-not-accept.md.',
    '',
    'okcore_flashsector is byte-identical to v2.1.1\'s, and all twelve of its',
    'patches match this release\'s sources - stage.js refuses a literal that',
    'does not match, so one that did not belong would have said so.',
  ].join('\n'),

  /*
   * v2.1.1's list, and this file said it would NOT copy that list because
   * "guessing which apply here would record a measurement nobody made".
   * That caution cost most of a day. With no patches this release stages,
   * builds, boots, provisions - and stores its PIN hash at a 64-bit stride
   * into a 32-bit-word flash layout, so every other word is lost and the
   * PIN never matches. Read straight out of flash.bin after a provision:
   *
   *   +0..3   e3e66c62   <- nonce word 0, then FOUR BYTES OF 0xFF
   *   +8..11  50f04142   <- nonce word 1, then 0xFF again
   *   +64..67 e8124951   <- p1hash word 0, same stride
   *
   * That is `unsigned long *adr` being 8 bytes on the host, exactly what
   * shared.flashWalkStride exists for, and okcore_flashsector is byte-
   * identical to v2.1.1's. The others are here because the code they patch
   * is also unchanged from v2.1.1; stage.js refuses a literal that does not
   * match, so anything in this list that did not belong would have said so.
   */
  /* Recorded from a production stage, which is how this release ships. */
  expect: { digest: 'cdd893849edb' },

  /*
   * Needed although this release SHIPS WITH DEBUG ON - it is the only pin whose
   * onlykey.h has `#define DEBUG` live (v2.1.1 and v3.0.0 comment it out). The
   * matrix builds releases with OKEMU_PRODUCTION=1, which turns the gate off,
   * and then webcryptcheck() reads `buffer[0]` through the NULL that
   * ctap.cpp's add_existing_user_info() passes it. Without this the firmware
   * thread took SIGSEGV at device.cpp's OKCONNECT branch during thirdParty's
   * example.test derive, the app process died, and the runner reported
   * whatever window was behind it - Settings, or the launcher (2026-09-25,
   * 3/3 in the sweep, reproduced alone). A Teensy maps flash at 0x0, so real
   * keys read the vector table there and never fault; this is an emulation
   * fix, identical to v2.1.1's.
   */
  debugOffPatches: [shared.okconnectBufferGuard],

  patches: [
    shared.flashWalkStride,
    shared.droppedTransportResponse,
    shared.hwModelStackBuffer,
    ...shared.missingReturns,
    shared.byteprintNullArgument,
    shared.pageZeroDebugDump,
    ...shared.nullSetterPointers,
    shared.wipeSlotNullSetters,
    shared.hmacChallengeModeNullSetter,
  ],
};
