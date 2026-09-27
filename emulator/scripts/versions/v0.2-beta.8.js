'use strict';

const shared = require('./_shared');

/**
 * v0.2-beta.8 - the 2019 beta line, and the only firmware whose OKCONNECT
 * reply uses the layout the library calls 'legacy'.
 *
 * WHY IT IS WORTH REACHING FOR. Every other release in the matrix answers
 * OKCONNECT with the device public key at bytes 0..32. This one - it
 * defines `OKversion "v0.2-beta.8c"` at OnlyKey_Beta.ino:135 - puts it at
 * 21..53 with the version string in the clear before it, and the web app
 * has branched on that string since it was written
 * (onlykey-api.js:168-198). node-onlykey-lib learned to parse it in
 * transit.js and could not verify the branch against anything real,
 * because until this pin existed the matrix went back only to v2.1.0.
 *
 * WHAT IS DIFFERENT ABOUT STAGING IT. The sketch is at
 * OnlyKey_Beta/OnlyKey_Beta.ino rather than OnlyKey/OnlyKey.ino - a
 * different directory and a different file name - which is why stage.js
 * takes a `sketch` from the release rather than assuming one. Its library
 * pin has okcore, okcrypto, okeeprom and onlykey.h and no okpqc or
 * utility/, which is expected for 2019 and not by itself a problem: the
 * PQC paths are compiled from the newer tree or not at all.
 *
 * The patch list starts EMPTY on purpose. Every entry in _shared.js was
 * written against a specific line of a specific release, and guessing that
 * a 2019 tree needs the same ones would produce a pile of patches that
 * fail to apply and say nothing about why. The way this is meant to go is
 * the way the rungs in versions/index.js describe: run stage.js, read what
 * it names, add the one patch that fixes it, run again. Each rung is
 * something somebody watched happen.
 */
/*
 * THE SKETCH SEEDS ITS RNG FROM AN ADDRESS THAT IS A READING.
 *
 *   unsigned int analog1 = analogRead(ANALOGPIN1);
 *   RNG.stir((uint8_t *)analog1, sizeof(analog1), sizeof(analog1)*2);
 *
 * `analog1` is the sample, not a buffer. The cast turns a number between 0
 * and 1023 into a pointer and stir() reads four bytes from it. On a Teensy
 * that address is inside mapped flash, so it returns the same four bytes of
 * the device's own program image every boot - the seeding is wrong in a way
 * that still produces plausible output, which is why it shipped. On Android
 * the page is unmapped and the firmware thread dies in setup().
 *
 * The two fault addresses this was seen at, 0xe7 and 0x2e4, are 231 and 740.
 * They differ between runs because they are ADC samples, and that is what
 * identified the cast rather than the unrebased hardware register the notes
 * first suspected.
 *
 * Fixed by the firmware itself in OnlyKey-Firmware@926b052 (2020-05-22), the
 * commit that renamed the sketch: `RNG.stir((uint8_t *)&analog1, 2, 4)`. The
 * length drops to 2 because the reading is 16-bit after
 * analogReadResolution(16), and the entropy credit halves with it. This
 * patch takes only the ADDRESS, leaving the length and the credit as the
 * beta had them - the crash is the cast, and rewriting the rest would be
 * this repository deciding how much entropy a 2019 release was entitled to
 * claim.
 *
 * Version-local, not shared: no other release in the matrix contains the
 * line. See ok-rn/FINDING-the-beta-seeded-its-rng-from-an-address-that-was-a-number.md
 */
const rngStirsAnAddressNotAValue = {
  /* Staged under the canonical name, whatever the release called it. */
  file: 'sketch/OnlyKey.ino',
  edits: [
    ['RNG.stir((uint8_t *)analog1, sizeof(analog1), sizeof(analog1)*2);',
     'RNG.stir((uint8_t *)&analog1, sizeof(analog1), sizeof(analog1)*2);'],
    ['RNG.stir((uint8_t *)analog2, sizeof(analog2), sizeof(analog2)*2);',
     'RNG.stir((uint8_t *)&analog2, sizeof(analog2), sizeof(analog2)*2);'],
  ],
};

/*
 * THE SAME CAST, EIGHT MORE TIMES, IN THE LOOP THAT RUNS FOREVER.
 *
 * rngloop() stirs every touch pad and both analog pins into the pool on
 * every pass, and every one of them casts the READING to a pointer. The
 * sketch's two in setup() are only where it is reached first; this is where
 * it would have kept happening.
 *
 * Same fix, same reason, and the same upstream: today's okcore.cpp writes
 * `RNG.stir((uint8_t *)&analog1, 2, 2)`. Address only - the lengths and
 * credits stay as the beta had them.
 */
const rngloopStirsAddressesNotValues = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['RNG.stir((uint8_t *)analog1, sizeof(analog1), sizeof(analog1) * 4);',
     'RNG.stir((uint8_t *)&analog1, sizeof(analog1), sizeof(analog1) * 4);'],
    ['RNG.stir((uint8_t *)touchread1, sizeof(touchread1), sizeof(touchread1));',
     'RNG.stir((uint8_t *)&touchread1, sizeof(touchread1), sizeof(touchread1));'],
    ['RNG.stir((uint8_t *)touchread2, sizeof(touchread2), sizeof(touchread2));',
     'RNG.stir((uint8_t *)&touchread2, sizeof(touchread2), sizeof(touchread2));'],
    ['RNG.stir((uint8_t *)touchread3, sizeof(touchread3), sizeof(touchread3));',
     'RNG.stir((uint8_t *)&touchread3, sizeof(touchread3), sizeof(touchread3));'],
    ['RNG.stir((uint8_t *)touchread4, sizeof(touchread4), sizeof(touchread4));',
     'RNG.stir((uint8_t *)&touchread4, sizeof(touchread4), sizeof(touchread4));'],
    ['RNG.stir((uint8_t *)touchread5, sizeof(touchread5), sizeof(touchread5));',
     'RNG.stir((uint8_t *)&touchread5, sizeof(touchread5), sizeof(touchread5));'],
    ['RNG.stir((uint8_t *)touchread6, sizeof(touchread6), sizeof(touchread6));',
     'RNG.stir((uint8_t *)&touchread6, sizeof(touchread6), sizeof(touchread6));'],
    ['RNG.stir((uint8_t *)analog2, sizeof(analog2), sizeof(analog2) * 4);',
     'RNG.stir((uint8_t *)&analog2, sizeof(analog2), sizeof(analog2) * 4);'],
  ],
};

/**
 * The 32-bit flash stride, spelled for the 2019 tree.
 *
 * IDENTICAL IN KIND to `_shared.js:flashWalkStride`, which every 2.x and 3.x
 * script imports and whose comment reads "without this the PIN never
 * matches". It cannot simply be imported here: this release predates the
 * rename, so its functions are `onlykey_flashget_common` /
 * `onlykey_flashset_common` where later ones are `okcore_*`, and stage.js
 * refuses a literal that does not match.
 *
 * Kept version-local rather than added to _shared.js on that file's own rule:
 * it holds patches MORE THAN ONE release needs, and exactly one release uses
 * this spelling.
 *
 * WHY IT IS ALMOST CERTAINLY WHAT AILS THIS RELEASE. v2.1.2 was staged with
 * an empty patch list and showed precisely the symptom recorded below -
 * boots, provisions, reports INITIALIZED, every button arrives as itself, and
 * the unlock times out. Dumping flash.bin off the phone showed the nonce and
 * the PIN hash present at the right offsets with every other 32-bit word
 * missing, because `unsigned long` is 8 bytes on a 64-bit host and the walk
 * advances twice as far as the byte buffer beside it. Importing the shared
 * list took that release from blocked to 87 passed.
 * ok-rn/FINDING-v2.1.2-sets-a-pin-it-will-not-accept.md
 */
const flashWalkStride2019 = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['void onlykey_flashget_common(uint8_t *ptr, unsigned long *adr, int len)\n{\n',
     'void onlykey_flashget_common(uint8_t *ptr, unsigned long *adr_in, int len)\n{\n' +
     '\t/* Injected by ok-rn stage.js - see scripts/versions/v0.2-beta.8.js.\n' +
     '\t   unsigned long is 8 bytes on a 64-bit host, which walks flash at\n' +
     '\t   twice the stride of the byte buffer beside it. */\n' +
     '\tuint32_t *adr = (uint32_t *)adr_in;\n'],
    ['void onlykey_flashset_common(uint8_t *ptr, unsigned long *adr, int len)\n{\n',
     'void onlykey_flashset_common(uint8_t *ptr, unsigned long *adr_in, int len)\n{\n' +
     '\t/* Same 32-bit stride as onlykey_flashget_common above. */\n' +
     '\tuint32_t *adr = (uint32_t *)adr_in;\n'],
  ],
};

/**
 * Setters handed a literal 0 where they dereference a pointer, 2019 spelling.
 *
 * SAME DEFECT AND SAME THREE SHAPES as `_shared.js:nullSetterPointers`, which
 * v2.1.0 and v2.1.1 import; this tree predates the rename, so its setters are
 * `onlykey_eeset_*` where later releases have `okeeprom_eeset_*`, and a
 * literal cannot be shared across that.
 *
 * MEASURED, from the tombstone rather than from reading:
 *
 *   F/libc  Fatal signal 11 (SIGSEGV), fault addr 0x0 in tid (okemu-firmware)
 *     #00 onlykey_eeset_common+76
 *     #01 onlykey_eeset_failedlogins+28
 *     #02 payload(int)+804
 *     #03 checkKey(Task*)+808
 *     #04 SoftTimerClass::testAndCall(Task*)+196
 *
 * On a Teensy the write goes to address 0 and is harmless enough to have
 * shipped; hosted, it takes the whole process down, which is why this read as
 * "the app leaves the screen during PIN entry" for three runs before anyone
 * captured logcat while it happened.
 *
 * The third site is spelled with a space before the paren and carries no
 * comment - the shared patch records the same trap, and it is found by
 * scanning the STAGED tree for setters whose first argument is a numeric
 * literal rather than by reading a diff.
 */
const nullSetterPointers2019 = {
  file: 'sketch/OnlyKey.ino',
  edits: [
    ['onlykey_eeset_failedlogins(0); //Set failed login counter to 0',
     '{ uint8_t zero = 0; onlykey_eeset_failedlogins(&zero); } //Set failed login counter to 0 - null pointer, see scripts/versions/v0.2-beta.8.js'],
    ['onlykey_eeset_sincelastregularlogin(0); //Set failed logins since last regular login to 0',
     '{ uint8_t zero = 0; onlykey_eeset_sincelastregularlogin(&zero); } //Set failed logins since last regular login to 0 - null pointer, see scripts/versions/v0.2-beta.8.js'],
    ['onlykey_eeset_sincelastregularlogin (0);',
     '{ uint8_t zero = 0; onlykey_eeset_sincelastregularlogin(&zero); } /* null pointer, see scripts/versions/v0.2-beta.8.js */'],
  ],
};

module.exports = {
  version: 'v0.2-beta.8',
  pins: { libraries: '307ba86', 'OnlyKey-Firmware': '697c4c0' },
  sketch: { dir: 'OnlyKey_Beta', file: 'OnlyKey_Beta.ino' },
  /*
   * Base patches whose patterns this 2019 tree does not contain. Declared
   * rather than silently skipped, and stage.js throws if one of them turns
   * out to be present after all.
   *
   *   factorysectoradr   arrived after this release; okcore.h has
   *                      fwstartadr, flashstorestart and flashend, which
   *                      are rebased as usual, and no factory sector at all.
   *   the ctap_parse.cpp CBOR span - this release predates that line in the
   *                      fido2 library; the file is there, the cast is not.
   */
  absentPatterns: [
    '#define factorysectoradr 0x5800',
    'uint32_t length = (uint32_t)end_byte - (uint32_t)start_byte;',
    /*
     * node-onlykey-emulator's own patches, which ok-rn does not carry. Checked
     * against this pin, 2026-09-27:
     *
     * uECC.c - the emulator adds a uECC_point_mult() prototype above
     * uECC_shared_secret2(), whose call to it clang 16 rejects as an implicit
     * declaration. This release has no uECC_shared_secret2 at all, so there is
     * no such call to fix.
     *
     * Profile_Offset (win32: password.cpp and the sketch) - the emulator
     * retypes the extern to int, because MSVC mangles a global's type into its
     * name. This release predates profiles: Profile_Offset appears nowhere in
     * its tree, so there is nothing to retype.
     */
    'int uECC_shared_secret2(const uint8_t *public_key,',
    'extern uint8_t Profile_Offset;',
  ],
  status: 'boots',
  emulator: { linux: 'boots', win32: 'untried' },   /* node-onlykey-emulator's own ladder: linux boots = matrix stage/build/press/compat PASS, VM x64, 2026-09-27 */
  notes: [
    'IT UNLOCKS. The 2019 beta has never unlocked in this project until now:',
    '45 passed, 2 failed, 10 skipped, up from 12 passed. It boots, provisions,',
    'unlocks with its PIN on three runs out of three, reads and writes labels,',
    'and gets as far as cryptoSign.',
    '',
    'IT NEEDED TWO SHARED PATCHES IT NEVER HAD, both in the 2019 spelling.',
    'This script carried only its own two RNG fixes, and no shared list at',
    'all - the same gap that made v2.1.2 store a PIN it then refused.',
    '',
    '  flashWalkStride2019      unsigned long is 8 bytes on a 64-bit host, so',
    '                           the flash walk advanced twice as far as the',
    '                           byte buffer beside it and every other 32-bit',
    '                           word was lost. Proved by dumping flash.bin:',
    '                           a contiguous 64-byte run at sector 118 +0',
    '                           where there had been four-on/four-off.',
    '  nullSetterPointers2019   three setters handed a literal 0 where they',
    '                           dereference a pointer. Proved by the tombstone:',
    '                           SIGSEGV at 0x0 in onlykey_eeset_common, from',
    '                           onlykey_eeset_failedlogins, from payload().',
    '                           On a Teensy that write is harmless enough to',
    '                           have shipped; hosted it kills the process, so',
    '                           it read as "the app leaves the screen during',
    '                           PIN entry" until someone captured logcat while',
    '                           it happened.',
    '',
    'CONFIG MODE IS ENTERED NOW. This line was the config-mode gesture, and it',
    'was a real firmware difference rather than a timing guess: every gesture',
    'branch in this payload() reads `duration >= 90`, where the 2.1 and 3.0',
    'lines read 72, so its ordinary long press is 21..89 instead of 21..71.',
    'The band table in version.js is version-aware for it now.',
    '',
    'Found by console then sweep, because reading the source had already',
    'misled once here. An 80-tick hold became "Button selected6 / Slot Number',
    '6 / Displaying Full Keybuffer" - an ordinary long press typing slot 6 -',
    'and a sweep locked the device at 120. Only then did the branch confirm 90.',
    '',
    'WHAT IS LEFT is past the door rather than at it: five failures in config',
    'mode itself, on touch sensitivity (field 28), key-slot naming and slot',
    'bounds. These look like 2019-versus-modern protocol differences and none',
    'is measured yet.',
    '',
    'ITS DEBUG BUILD IS USABLE AGAIN, which is what makes that measurable. It',
    'used to die in ctapFlow on a null _appid inside webcryptcheck, because',
    'this release is the ONLY one whose #ifdef DEBUG block is empty - every',
    'other release returns 2 before reaching the comparison, which is the',
    'assumption stage.js had baked into DEBUG_OFF_PATCHES. The guard is now',
    'applied on both builds. Debug goes 73 passed where it used to crash.',
    ].join(String.fromCharCode(10)),
  /*
   * WHICH SHARED PATCHES THIS 2019 TREE CAN TAKE, tested rather than guessed.
   * Each of _shared.js's literals was matched against the STAGED tree before
   * being listed here, and only three match unchanged:
   *
   *   byteprintNullArgument   byteprint() is byte-identical, so the shared
   *                           literal applies as-is
   *   missingReturns[2]       only the ok_extension.cpp entry matches; the
   *                           okcore.cpp and device.cpp entries do not exist
   *                           in this tree, and stage.js refuses a literal it
   *                           cannot find, so the spread cannot be used
   *   pageZeroDebugDump       matches unchanged
   *
   * The rest do not match, almost all because this release predates the
   * okcore_/okeeprom_ renames - which is why flashWalkStride and
   * nullSetterPointers are re-spelled above rather than imported.
   */
  patches: [
    flashWalkStride2019,
    nullSetterPointers2019,
    shared.byteprintNullArgument,
    shared.missingReturns[2],
    shared.pageZeroDebugDump,
    rngStirsAnAddressNotAValue,
    rngloopStirsAddressesNotValues,
  ],
};
