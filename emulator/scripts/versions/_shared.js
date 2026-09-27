'use strict';
/*
 * Stage patches that MORE THAN ONE release needs.
 *
 * A version script imports what it needs from here by name, so a fix written
 * once is applied identically everywhere it belongs - and, just as important,
 * is NOT applied to a release that was measured not to need it. Nothing in this
 * file is applied automatically.
 *
 * Everything here obeys the same rule as stage.js's own PATCHES: the minimum to
 * make the firmware COMPILE hosted, never to improve it or change its protocol.
 * Where the current sources already solve the same problem, the fix here copies
 * theirs, so behaviour does not differ by version.
 */

/**
 * `Profile_Offset` is declared twice in one translation unit with two different
 * types - `int` in profile1hashevaluate() and `uint8_t` in
 * profile2hashevaluate(). okcore.cpp DEFINES it as `int`, so both spellings
 * cannot be right, and clang rejects the disagreement outright. The Teensy
 * toolchain that shipped these releases did not.
 *
 * The CURRENT libraries checkout already fixes this, behind `#ifdef
 * OK_EMULATOR`, and its comment says why it chose `uint8_t` for both rather
 * than the `int` that matches the definition:
 *
 *   "declaring them `int` would change what the device reads back from a
 *    negative Profile_Offset (OnlyKey.ino assigns -42, seen as 214 through
 *    the uint8_t spelling)"
 *
 * So this makes the same choice. Reading a negative int through a uint8_t
 * extern yields its low byte, which is the value the device actually behaves
 * on; "correcting" it to int would be a behaviour change wearing a type fix, on
 * firmware we are supposed to run as it shipped.
 *
 * MEASURED, not guessed. `git show <pin>:password/password.cpp` at each pinned
 * commit:
 *
 *   v3.0.2  5d7ce7a   one `int`, one `uint8_t`  -> needs this
 *   v3.0.1  a27ffa6   one `int`, one `uint8_t`  -> needs this
 *   v3.0.0  5515974   one `int`, one `uint8_t`  -> needs this
 *   v2.1.1  0dc7cf0   two `uint8_t`             -> already consistent
 *   v2.1.0  8687474   two `uint8_t`             -> already consistent
 *
 * So the 2.1 line predates the disagreement and the 3.0 line introduced it.
 * Their scripts do not import this.
 */
const profileOffsetType = {
  file: 'libraries/password/password.cpp',
  edits: [
    ['\tuint8_t nonce2[32];\n\textern int Profile_Offset;',
     '\tuint8_t nonce2[32];\n\textern uint8_t Profile_Offset; /* was int - see scripts/versions/_shared.js */'],
  ],
};

/* ------------------------------------ the OKCONNECT branch's null buffer */

/*
 * The third of webcryptcheck()'s null dereferences, and the one that is
 * spelled differently before and after v3.0.2 - which is why it is here rather
 * than in stage.js's shared DEBUG_OFF_PATCHES.
 *
 * Same defect as its two siblings: callers pass NULL for `buffer` and only the
 * `#ifdef DEBUG` early return above kept a debug build from reading through it.
 * With the gate off - which is how every release ships - the branch below
 * dereferences it. See FINDING-production-firmware-crashes-in-webcryptcheck.md.
 *
 * MEASURED at every pin. `git show <pin>:fido2/device.cpp`:
 *
 *   v3.0.2   ... buffer[4]==OKCONNECT && is_bit_set(derived_key_challenge_mode, 2)
 *   v3.0.1   ... buffer[4]==OKCONNECT
 *   v3.0.0   ... buffer[4]==OKCONNECT
 *   v2.1.1   ... buffer[4]==OKCONNECT
 *   v2.1.0   ... buffer[4]==OKCONNECT
 *
 * The derived-key challenge clause arrived in v3.0.2. A single pattern
 * carrying it applies to exactly one release and silently misses the other
 * four, which is what version-probe.js reported the moment these were added to
 * its sweep.
 */
const PREFIX = '    } else if (';
const TAIL = 'buffer[0]==0xFF && buffer[1]==0xFF && buffer[2]==0xFF && buffer[3]==0xFF && ';

/** v3.0.1 and earlier. */
const okconnectBufferGuard = {
  file: 'libraries/fido2/device.cpp',
  edits: [
    [PREFIX + TAIL + 'buffer[4]==OKCONNECT) {',
     PREFIX + 'buffer != NULL && ' + TAIL + 'buffer[4]==OKCONNECT) {'],
  ],
};

/** v3.0.2 and later, including the working tree. */
const okconnectBufferGuardWithChallengeMode = {
  file: 'libraries/fido2/device.cpp',
  edits: [
    [PREFIX + TAIL + 'buffer[4]==OKCONNECT && is_bit_set(derived_key_challenge_mode, 2)) {',
     PREFIX + 'buffer != NULL && ' + TAIL + 'buffer[4]==OKCONNECT && is_bit_set(derived_key_challenge_mode, 2)) {'],
  ],
};

/* ------------------------------------ EEPROM setters passed a null pointer */

/*
 * `okeeprom_eeset_failedlogins(0)` and friends pass a NULL POINTER, not the
 * value zero, and the setter dereferences it.
 *
 * On the MK20DX256 this works by accident: address 0 is the vector table, whose
 * first byte little-endian is 0x00, so reading through the null pointer yields
 * exactly the zero the caller meant. Nothing faults and nobody notices.
 *
 * Hosted, address 0 is unmapped - Android pins vm.mmap_min_addr at 0x8000 and
 * an unprivileged app cannot lower it - so the same call takes SIGSEGV and the
 * firmware THREAD DIES. The app stays up, the device simply stops answering,
 * and every later request times out naming nothing.
 *
 * The failedlogins one is on the successful-login path, so the symptom is a
 * device that cannot be unlocked AT ALL: enter the right PIN and the firmware
 * dies in the act of recording the success. Measured on v3.0.2, where six
 * suites failed and the whole run overran its budget:
 *
 *     ✗ unlocks with the PIN -> the device did not unlock within 20000ms
 *     ✗ reads its labels now that it is unlocked -> only status broadcasts
 *
 * ## This is upstream's own fix, copied
 *
 * The CURRENT checkouts already carry it, written exactly this way:
 *
 *     { uint8_t zero = 0; okeeprom_eeset_failedlogins(&zero); }
 *
 * with a comment explaining the vector-table accident. So this is not our
 * invention and not a behaviour change - it is the same correction, applied to
 * the releases that predate it. On the device both spellings store zero.
 *
 * Matched WITHOUT leading whitespace, because the same statement is indented
 * with tabs in okcore.cpp and spaces in the sketch, and it has to apply to
 * five releases.
 */
const nullSetterPointers = [
  {
    file: 'sketch/OnlyKey.ino',
    edits: [
      ['okeeprom_eeset_failedlogins(0); //Set failed login counter to 0',
       '{ uint8_t zero = 0; okeeprom_eeset_failedlogins(&zero); } //Set failed login counter to 0 - null pointer, see scripts/versions/_shared.js'],
      ['okeeprom_eeset_sincelastregularlogin(0); //Set failed logins since last regular login to 0',
       '{ uint8_t zero = 0; okeeprom_eeset_sincelastregularlogin(&zero); } //Set failed logins since last regular login to 0 - null pointer, see scripts/versions/_shared.js'],
      /*
       * A THIRD site in the same file, spelled with a space before the paren
       * and carrying no comment, on the self-destruct path in payload(). Found
       * by scanning the STAGED tree for setters whose first argument is a
       * numeric literal rather than by reading the diff, which is how the
       * first two were found and how this one was missed.
       */
      ['okeeprom_eeset_sincelastregularlogin (0);',
       '{ uint8_t zero = 0; okeeprom_eeset_sincelastregularlogin(&zero); } /* null pointer, see scripts/versions/_shared.js */'],
    ],
  },
  {
    file: 'libraries/onlykey/okcore.cpp',
    edits: [
      ['okeeprom_eeset_timeout(0); // No timeout as there is no PIN required',
       '{ uint8_t zero = 0; okeeprom_eeset_timeout(&zero); } // No timeout as there is no PIN required - null pointer, see scripts/versions/_shared.js'],
    ],
  },
];

/**
 * The same defect in wipe_slot(), which v2.1.0 does not have.
 *
 * TWO BYTES, not one, and that is the working tree's own note:
 * yubikey_eeset_counter writes EElen_counter (2) on slot 0 and a single byte on
 * slots 1-24, so a one-byte local would be read past.
 *
 * This pair is how the family was found upstream - as a segfault in wipe_slot()
 * under the Node emulator - and it is the reason to scan the staged tree for
 * the SHAPE rather than fix sites one at a time.
 *
 * Measured absent at 8687474: v2.1.0's wipe_slot has no `(0, slot)` call of
 * either name. version-probe.js reported it the moment this was written as a
 * universal patch, which is what that sweep is for.
 */
const wipeSlotNullSetters = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['okeeprom_eeset_2FAtype(0, slot);',
     '{ uint8_t zeros[2] = { 0, 0 }; okeeprom_eeset_2FAtype(zeros, slot); } /* null pointer, see scripts/versions/_shared.js */'],
    ['yubikey_eeset_counter(0, slot);',
     '{ uint8_t zeros[2] = { 0, 0 }; yubikey_eeset_counter(zeros, slot); } /* null pointer, see scripts/versions/_shared.js */'],
  ],
};

/**
 * The fourth site, which v2.1.0 does not have.
 *
 * Same defect, same fix. Present at v2.1.1 and everything after it; measured
 * absent at 8687474.
 */
const hmacChallengeModeNullSetter = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['okeeprom_eeset_hmac_challengemode(0); // Reset to default both slots require button press',
     '{ uint8_t zero = 0; okeeprom_eeset_hmac_challengemode(&zero); } // Reset to default both slots require button press - null pointer, see scripts/versions/_shared.js'],
  ],
};

/* ------------------------------------------- 64-bit flash walk (THE BIG ONE) */

/*
 * okcore_flashget_common() and okcore_flashset_common() walk flash through an
 * `unsigned long *`, and `unsigned long` IS NOT 32 BITS on a 64-bit host.
 *
 * The loop steps the byte buffer by four (`z = z + 4`) and the address by one
 * pointer increment. On the MK20DX256 those agree - `unsigned long` is 4 bytes.
 * On arm64 and x86_64 it is 8, so the address advances TWICE as fast as the
 * data: every other word of every field is read from, or written to, the wrong
 * place. The field offsets themselves are plain byte arithmetic and do not
 * double, so nothing is out of range and nothing faults. It just silently
 * reads and writes the wrong flash.
 *
 * ## How it presents, which is nothing like its cause
 *
 * The PIN hash goes through these. A device provisions, reports INITIALIZED,
 * accepts every button press, evaluates the hash - and the answer never
 * matches, because the stored hash was written through one stride and read
 * back through another:
 *
 *     GUESSED PROFILE 1 PIN  31 32 33 34 35 36 31
 *     Guessed Hash/PublicKey:    7C 51 67 D6 76 E6 10 65 ...
 *     Stored PIN Hash/PublicKey: D3 6A 49 6A AB 95 D1 9D ...
 *
 * So it reads as "the PIN is wrong" on a device whose PIN is right.
 *
 * ## Why it took a 64-bit phone to see
 *
 * armeabi-v7a has a 4-byte `unsigned long`, so the 32-bit build is correct by
 * accident. The bench device that has always worked is a 32-bit handset. The
 * same firmware on an arm64 phone cannot be unlocked at all.
 *
 * ## Upstream's own fix, copied
 *
 * The current checkouts rename the parameter and take a uint32_t view of it -
 * `uint32_t *adr = (uint32_t *)adr_in;` - which is the whole change. Nothing
 * about the flash format moves; the device stores exactly what it always did.
 */
const flashWalkStride = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['void okcore_flashget_common(uint8_t *ptr, unsigned long *adr, int len)\n{\n',
     'void okcore_flashget_common(uint8_t *ptr, unsigned long *adr_in, int len)\n{\n' +
     '\t/* Injected by ok-rn stage.js - see scripts/versions/_shared.js.\n' +
     '\t   unsigned long is 8 bytes on a 64-bit host, which walks flash at\n' +
     '\t   twice the stride of the byte buffer beside it. */\n' +
     '\tuint32_t *adr = (uint32_t *)adr_in;\n'],
    ['void okcore_flashset_common(uint8_t *ptr, unsigned long *adr, int len)\n{\n',
     'void okcore_flashset_common(uint8_t *ptr, unsigned long *adr_in, int len)\n{\n' +
     '\t/* Same 32-bit stride as okcore_flashget_common above. */\n' +
     '\tuint32_t *adr = (uint32_t *)adr_in;\n'],
  ],
};

/* ---------------------------------------------- byteprint's null argument */

/*
 * byteprint() dereferences a pointer its callers hand it as NULL.
 *
 * webcryptcheck() does `byteprint(_appid, 32)` on a path where
 * ctap_filter_invalid_credentials() passed no appid at all. On the MK20DX256
 * address 0 is the vector table and readable, so it prints 32 bytes of nonsense
 * to a console nobody is reading and carries on. Hosted, page zero is unmapped
 * and the firmware thread takes SIGSEGV mid-getAssertion:
 *
 *     signal 11 (SIGSEGV), SEGV_MAPERR, fault addr 0x0 (read)
 *     Cause: null pointer dereference
 *       #00 byteprint+68
 *       #01 webcryptcheck+308
 *       #02 ctap_filter_invalid_credentials(CTAP_getAssertion*)+560
 *       #03 ctap_get_assertion(CborEncoder*, unsigned char*, int)+496
 *
 * ## Only a DEBUG build reaches it
 *
 * The whole body is inside `#ifdef DEBUG`, so a release build never dereferences
 * anything here - which is why this stayed hidden until a pinned release was
 * staged with OKEMU_DEBUG=1 to make it provisionable. The same NULLs on a
 * production build are the appid_match comparisons further down, which
 * DEBUG_OFF_PATCHES already guards. Two spellings of one defect, one on each
 * side of the gate.
 *
 * Upstream's own fix, copied verbatim: an early return, with the comment naming
 * the caller.
 */
const byteprintNullArgument = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['void byteprint(uint8_t *bytes, int size)\n{\n#ifdef DEBUG\n',
     'void byteprint(uint8_t *bytes, int size)\n{\n#ifdef DEBUG\n' +
     '\t// Callers hand this null freely - webcryptcheck() does byteprint(_appid, 32)\n' +
     '\t// on a path where ctap_filter_invalid_credentials() passed no appid at all.\n' +
     '\tif (!bytes) return;\n'],
  ],
};

/* ------------------------------------- the FULLWIPE debug dump of page zero */

/*
 * factorydefault()'s FULLWIPE branch prints 64 KB starting at address 0.
 *
 * It is diagnostic output and nothing depends on its contents, but on a hosted
 * build page zero is deliberately left unmapped - mapping it would need
 * vm.mmap_min_addr=0, which removes NULL-dereference protection machine-wide -
 * so the first iteration faults and takes the firmware thread with it.
 *
 * Only a DEBUG build reaches it, which is every pinned release staged with
 * OKEMU_DEBUG=1 to make it provisionable.
 *
 * The current checkouts already gate this behind `#ifdef OK_EMULATOR` and start
 * at the first mapped flash page instead. Their comment is copied along with
 * the value; there is no OK_EMULATOR gate at these pins, so the replacement is
 * unconditional in the staged copy - which is the same thing, since the staged
 * copy is only ever the hosted build.
 */
const pageZeroDebugDump = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['#ifdef DEBUG\n\t\tuintptr_t adr = 0x0;',
     '#ifdef DEBUG\n' +
     '\t\t/* Injected by ok-rn stage.js - see scripts/versions/_shared.js.\n' +
     '\t\t   Page zero is deliberately left unmapped on a hosted build (mapping\n' +
     '\t\t   it would need vm.mmap_min_addr=0, removing NULL-dereference\n' +
     '\t\t   protection machine-wide). Start at the first mapped flash page\n' +
     '\t\t   instead - this is diagnostic output only. */\n' +
     '\t\tuintptr_t adr = 0x1000;'],
  ],
};

/* ------------------------ falling off the end of a non-void function */

/*
 * Three firmware functions reach their closing brace without a return. That is
 * undefined behaviour, and the two compilers make wildly different choices:
 *
 *   arm-none-eabi-g++ 4.8 -Os   emits the ordinary epilogue and returns
 *                               whatever is in r0. Garbage, but the stack is
 *                               intact and the caller resumes.
 *   a modern host compiler      treats the end as unreachable, emits NO
 *                               epilogue and NO ret, and control runs into
 *                               whatever block was laid out next.
 *
 * For ctap_flash() that is not subtle. In the Node emulator the tail of the
 * mode==2 body was laid directly ahead of the shared "erase failed" block and
 * the loop closed with a jump back into the middle of the function - so a FIDO2
 * REGISTRATION spun the firmware thread at 100% CPU forever, never returned to
 * ctap_make_credential(), and never sent a CTAPHID response. The browser
 * reported a plain "response timeout".
 *
 * The other two are the same defect on paths that had not been hit yet.
 *
 * ## Returning what the function's own successful path returns
 *
 * Not invented behaviour, and in every case the callers of the affected path
 * ignore the result:
 *
 *   ctap_flash            mode 2 (write RK) is called for effect and its
 *                         result discarded; only mode 3 is read, and that
 *                         returns.
 *   ctap_atomic_count     the amount != 0 paths come from a caller that
 *                         ignores the result; every reader passes 0.
 *   send_stored_response  falls through when profilemode is
 *                         NONENCRYPTEDPROFILE, where ret is still its
 *                         initial 0.
 *
 * From node-onlykey-emulator's stage.js before those patches were moved
 * upstream behind OK_EMULATOR (77d0b64), which is where the diagnosis above
 * comes from. Worth knowing for the next one: the firmware compiles with -w,
 * so -Wreturn-type never printed.
 */
const missingReturns = [
  {
    file: 'libraries/onlykey/okcore.cpp',
    edits: [
      /* ctap_flash(), mode 2 - the one that hung every FIDO2 registration. */
      ['\t\t//hidprint("Successfully set CTAP Value");\n\t}\n\t#endif\n}',
       '\t\t//hidprint("Successfully set CTAP Value");\n\t}\n\t#endif\n' +
       '\treturn 0; /* fell off the end - see scripts/versions/_shared.js */\n}'],
    ],
  },
  {
    file: 'libraries/fido2/device.cpp',
    edits: [
      /* ctap_atomic_count(): the amount != 0 branch sets and falls through. */
      ['    } else {\n        setCounter(amount+counter1);\n    }\n}',
       '    } else {\n        setCounter(amount+counter1);\n    }\n' +
       '    return getCounter(); /* fell off the end - see _shared.js */\n}'],
    ],
  },
  {
    file: 'libraries/fido2/ok_extension.cpp',
    edits: [
      /* send_stored_response(): a non-encrypted profile falls through. */
      ['\t\treturn ret; \n\t}\n}',
       '\t\treturn ret; \n\t}\n' +
       '\treturn ret; /* fell off the end - see _shared.js */\n}'],
    ],
  },
];

/*
 * HW_MODEL() returns a pointer to a stack-allocated VLA.
 *
 *     char out[strlen(in)+2];  ...  return (char*)out;
 *
 * The array dies with the frame, so the caller reads freed stack. On the
 * MK20DX256 - bare metal, -Os, one thread, no red-zone reuse before the callee
 * runs - the bytes survive long enough for hidprint() to copy them, so the
 * device works. Hosted, the very next call clobbers that frame and hidprint()
 * dereferences null, which crashes on ANY status reply.
 *
 * A function-static buffer has the same single-threaded lifetime the callers
 * already assume - the result is consumed immediately by hidprint - and removes
 * the undefined behaviour. Bounded so a long input cannot overrun. This is
 * exactly what the current checkouts now do, unconditionally.
 */
const hwModelStackBuffer = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['\tchar out[strlen(in)+2];\n\tmemcpy(out,in,strlen(in));',
     '\t/* Injected by ok-rn stage.js - see scripts/versions/_shared.js.\n' +
     '\t   The VLA this replaces died with the frame and was returned. */\n' +
     '\tstatic char out[64];\n\tsize_t okemu_n = strlen(in);\n' +
     '\tif (okemu_n > sizeof(out) - 2) okemu_n = sizeof(out) - 2;\n' +
     '\tmemcpy(out, in, okemu_n);'],
    ['out[sizeof(out)-2]', 'out[okemu_n]'],
    ['\tout[sizeof(out)-1] = 0;', '\tout[okemu_n + 1] = 0;'],
  ],
};

/* ------------------------------------------ the dropped transport response */

/*
 * send_transport_response() calls `RawHID.send2(resp_buffer, 0)` and never
 * looks at what it returns.
 *
 * A zero timeout means "give up immediately if the firmware's four-packet TX
 * queue is still full" (TX_PACKET_LIMIT, usb_rawhid.c). It then returns 0
 * without sending, and since nothing checks, THE ANSWER IS SILENTLY DROPPED.
 * The request itself was processed - the key really is written, the preference
 * really is set - only the reply never leaves.
 *
 * ## Why this is a hosting patch and not an improvement
 *
 * On the device the queue drains in microseconds, so the window is almost never
 * open and the bug is invisible. In an emulated USB stack it drains only when
 * the host side reads, so the window is wide and the bug is CONSTANT: two
 * vendor requests in a row, and the second answer is gone. Patching restores
 * the behaviour a real OnlyKey shows; leaving it makes the emulator fail for a
 * reason the hardware would not.
 *
 * Measured, and it is what stalled the version matrix. Sending a preference
 * write and then a key write back to back on v3.0.2:
 *
 *     pref: "Successfully set derived key challenge mode"
 *     --- writing slot 101 with type 0x41 ---
 *     said: []
 *
 * The same key write with nothing before it answers "Successfully set ECC Key"
 * every time. Thirteen suites failed downstream of that one lost reply, all of
 * them reporting "no CTAPHID reply", none of them naming the cause.
 *
 * ## Upstream's own fix, copied
 *
 * The current checkouts give each attempt a real 100ms budget and retry five
 * times, with a comment calling this the root cause of "the intermittent
 * truncated multi-packet responses seen from the host side all session". So
 * this is a bug the newer firmware FIXED, not a feature it gained - which is
 * the distinction the whole version matrix exists to draw.
 */
const droppedTransportResponse = {
  file: 'libraries/onlykey/okcore.cpp',
  edits: [
    ['\t\t\tRawHID.send2(resp_buffer, 0);',
     '\t\t\t/* Injected by ok-rn stage.js - see scripts/versions/_shared.js.\n' +
     '\t\t\t   send2(buf, 0) returns 0 without sending when the TX queue is\n' +
     '\t\t\t   full, and nothing checked. Hosted, that queue drains only when\n' +
     '\t\t\t   the host reads, so the reply to any request following another\n' +
     '\t\t\t   one was lost. */\n' +
     '\t\t\tfor (int okemu_tries = 0; okemu_tries < 5; okemu_tries++) {\n' +
     '\t\t\t\tif (RawHID.send2(resp_buffer, 100)) break;\n' +
     '\t\t\t}'],
  ],
};

module.exports = {
  profileOffsetType,
  droppedTransportResponse,
  missingReturns,
  hwModelStackBuffer,
  pageZeroDebugDump,
  byteprintNullArgument,
  flashWalkStride,
  nullSetterPointers,
  wipeSlotNullSetters,
  hmacChallengeModeNullSetter,
  okconnectBufferGuard,
  okconnectBufferGuardWithChallengeMode,
};
