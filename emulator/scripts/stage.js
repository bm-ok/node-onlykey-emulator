#!/usr/bin/env node
/*
 * stage.js - assemble the complete compile tree for the emulator.
 *
 * This mirrors arduino-1.6.5-r5-teensy_127/in-docker-build.sh, which builds by
 * COPYING everything into a scratch Arduino tree rather than compiling in
 * place:
 *
 *     cp OnlyKey-Firmware/*.c *.h  -> cores/teensy3/     (shadows core files)
 *     cp libraries/*               -> arduino/libraries/
 *
 * We do the same into emulator/.stage, then overlay emulator/core-override/.
 * Nothing in the component checkouts beside this repo is ever written to.
 *
 * The firmware's own host-build adaptations live in the OnlyKey sources
 * themselves, behind `#ifdef OK_EMULATOR` (defined by binding.gyp, never by the
 * device toolchain). Only the vendored Teensy core - which is not OnlyKey code
 * and should not carry emulator knowledge - is still patched textually here.
 *
 * Layout produced:
 *   .stage/core/       teensy3 core + OnlyKey USB stack + our overrides
 *   .stage/libraries/  OnlyKey's vendored Arduino libraries
 *   .stage/sketch/     OnlyKey.ino
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EMU = path.resolve(__dirname, '..');
const ROOT = path.resolve(EMU, '..');
/* The components are checkouts beside this repo, not inside it - see setup.sh. */
const CHECKOUTS = path.resolve(ROOT, '..');
const ARDUINO = path.join(CHECKOUTS, 'arduino-1.6.5-r5-teensy_127', 'arduino-1.6.5-r5');
const CORE_SRC = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'cores', 'teensy3');
/*
 * The firmware sources. The working-tree checkouts by default; a released
 * version when OKEMU_VERSION names one, in which case materialiseVersion()
 * repoints these at that release's pinned commits (ok-versions.json).
 */
let FW = path.join(CHECKOUTS, 'OnlyKey-Firmware');
let LIB_SRC = path.join(CHECKOUTS, 'libraries');
const OVERRIDE = path.join(EMU, 'core-override');

/*
 * Released versions, unpacked by commit - see materialiseVersion(). Inside
 * this repo but gitignored: ~6 MB a version, and rebuilt from git on demand.
 */
const VERSION_CACHE = path.join(EMU, '.stage-src');

const STAGE = path.join(EMU, '.stage');
const STAGE_CORE = path.join(STAGE, 'core');
const STAGE_LIB = path.join(STAGE, 'libraries');
const STAGE_SKETCH = path.join(STAGE, 'sketch');

/*
 * Bare-metal files with no host equivalent. Each is either superseded by a
 * file in core-override/ or simply not compiled.
 */
const DROP = [
  'mk20dx128.c',        // reset handler, vector table, clock init
  'pins_teensy.c',      // -> core-override/okemu_pins.cpp (systick, GPIO)
  'analog.c',           // -> core-override/okemu_pins.cpp
  'touch.c',            // -> core-override/okemu_pins.cpp (buttons)
  'eeprom.c',           // -> core-override/okemu_eeprom.cpp (file-backed)
  'usb_dev.c',          // -> core-override/okemu_usb.cpp
  'usb_rawhid.c',       //    "
  'usb_keyboard.c',     //    "
  'usb_seremu.c',       //    "
  'usb_serial.c',       //    "
  'usb_mem.c',          // USB endpoint buffer allocator
  'usb_mouse.c', 'usb_joystick.c', 'usb_midi.c', 'usb_flightsim.c', 'usb_mtp.c',
  'serial1.c', 'serial2.c', 'serial3.c',
  'HardwareSerial1.cpp', 'HardwareSerial2.cpp', 'HardwareSerial3.cpp',
  'IntervalTimer.cpp',  // ARM NVIC periodic interrupt
  'DMAChannel.cpp',
  'AudioStream.cpp',
  'Tone.cpp',
  'avr_emulation.cpp',
  'ser_print.c',
  'math_helper.c',
  'memcpy-armv7m.S',
  'main.cpp',           // Arduino main(); the addon drives setup()/loop()
  'Makefile',
];

/*
 * Textual fixups applied to STAGED copies only.
 *
 * There is exactly one, and there should stay exactly one. Everything the
 * FIRMWARE needs in order to build and run on a host now lives in the OnlyKey
 * sources under `#ifdef OK_EMULATOR`, or - where the fix was correct on the
 * MK20DX256 too - as an unconditional correction. See the README section
 * "Running 32-bit firmware on a 64-bit host".
 *
 * What remains is the vendored Teensy core, which is not OnlyKey code. It
 * defines two constructs in terms of Cortex-M inline assembly, and a header's
 * own #define always wins over anything predefined from outside, so it cannot
 * be overridden by okemu_prelude.h or by -D. Patching the staged copy is the
 * only lever, and the core stays free of emulator knowledge.
 *
 * If you find yourself adding an entry here for an OnlyKey source file, gate it
 * in that file instead.
 */
const PATCHES = [
  {
    file: 'core/kinetis.h',
    edits: [
      // `cpsid i` / `cpsie i` mask interrupts. There are none here - the
      // firmware runs on one thread against memory-backed peripherals - so
      // these reduce to the compiler barrier the surrounding flash and USB
      // buffer code actually depends on.
      ['#define __disable_irq() __asm__ volatile("CPSID i":::"memory");',
       '#define __disable_irq() __asm__ volatile("":::"memory");'],
      ['#define __enable_irq()\t__asm__ volatile("CPSIE i":::"memory");',
       '#define __enable_irq()\t__asm__ volatile("":::"memory");'],
    ],
  },
  {
    /*
     * The Teensy core's GPIO bit-band macro computes an address in the 32 MB
     * alias region at 0x42000000. There is no alias region any more (see
     * rewriteRegisterBlocks()), and the inline members that expand this are
     * never called - so a call now fails to LINK against the undefined
     * okemu_bitband_unsupported() instead of writing through an address
     * nothing backs.
     */
    file: 'core/avr_emulation.h',
    edits: [
      ['#define GPIO_BITBAND_ADDR(reg, bit) (((uint32_t)&(reg) - 0x40000000) * 32 + (bit) * 4 + 0x42000000)',
       '#define GPIO_BITBAND_ADDR(reg, bit) (okemu_bitband_unsupported())'],
    ],
  },
  {
    /*
     * Print::println(size_t) is ambiguous on LLP64 - i.e. on Windows.
     *
     * Print declares overloads up to `unsigned long` and stops. On the device
     * and on Linux that is enough, because size_t IS unsigned long there
     * (ILP32 and LP64 both). Windows is LLP64: long stays 32 bits and size_t
     * is unsigned long long, which matches NONE of the overloads exactly and
     * converts equally well to several, so the call is ambiguous:
     *
     *     okcrypto.cpp:1070: Serial.println(rsa.len);   // rsa.len is size_t
     *     error: call to member function 'println' is ambiguous
     *
     * Twelve call sites across okcore.cpp and okcrypto.cpp, all of them debug
     * prints. Adding the missing overloads fixes every one without touching a
     * single call, and on Linux the new overloads are simply never selected.
     *
     * They narrow to unsigned long before printing. These print lengths and
     * addresses from a 32-bit firmware, so nothing being printed can exceed
     * 32 bits - and a println that truncates in some hypothetical future is a
     * far smaller problem than a core that will not compile.
     */
    /*
     * uECC calls uECC_point_mult() before it is declared.
     *
     * uECC.c:1098 calls it from inside uECC_shared_secret2(); the definition
     * is at :1109, eleven lines later, and there is no prototype anywhere. In
     * C89 that is legal - the compiler invents `int uECC_point_mult()`. C99
     * dropped implicit declarations, compilers warned about it for twenty
     * years, and clang 16 finally made it an error:
     *
     *     error: call to undeclared function 'uECC_point_mult'
     *     error: conflicting types for 'uECC_point_mult'
     *
     * The second error is the consequence of the first: the invented `int`
     * return type then clashes with the real `void` definition. So warning
     * flags cannot fix this - -Wno-implicit-function-declaration silences the
     * complaint but still invents the wrong declaration, and the conflict
     * stands. A real prototype is the only fix.
     *
     * Declared immediately above the function that calls it rather than at the
     * top of the file, so the addition sits next to what needs it and matches
     * the definition that follows a few lines later.
     */
    file: 'libraries/uECC/uECC.c',
    edits: [
      ['int uECC_shared_secret2(const uint8_t *public_key,',
       'void uECC_point_mult(uECC_word_t *result,\n'
       + '                     const uECC_word_t *point,\n'
       + '                     const uECC_word_t *scalar,\n'
       + '                     uECC_Curve curve);\n\n'
       + 'int uECC_shared_secret2(const uint8_t *public_key,'],
    ],
  },
  {
    /*
     * RNG2 IS DECLARED WITH THE WRONG SECOND PARAMETER, and on Windows that
     * is the 12-webauthn-tunnel crash.
     *
     * The definition, okcore.cpp:7630, and okcore.h:369:
     *
     *     int RNG2(uint8_t *dest, unsigned size)
     *
     * But tweetnacl.c:88 and justhashtweetnacl.c:86 both declare:
     *
     *     extern int RNG2(u8 *,u8);   //Max size 255
     *
     * C has no overloading, so both resolve to the one symbol: the caller
     * passes an 8-bit value and the callee reads a 32-bit one.
     *
     * WHY THIS IS HARMLESS EVERYWHERE ELSE. AAPCS and the SysV x86-64 ABI
     * require the CALLER to widen a narrow argument to a full register, so
     * the callee reading `unsigned` sees 32 and nothing is wrong. The
     * Microsoft x64 ABI does not: the upper bits of a narrow argument are
     * explicitly undefined, and the callee may not rely on them. So on
     * Windows `size` is 32 in its low byte and whatever was already in the
     * register above that.
     *
     * RNG2 then hands that to RNG.rand(dest, size) over crypto_box_keypair's
     * 32-byte buffer. A smashed stack is also why nothing could report the
     * fault: exception dispatch itself needs a sane stack, which is why
     * neither the vectored handler nor the SEH frame ever ran, and why 8 MB,
     * 64 MB and a stack guarantee all made no difference.
     *
     * Traced by console bisect: "A set_time returned" and "B memset done"
     * both print, RNG2's own "Generating random number of size" never does.
     *
     * Scoped to win32 because the Linux build has been correct by ABI luck
     * for years and this is not the place to change it - but the declarations
     * should simply be fixed upstream, where it costs nothing on any target.
     */
    platform: 'win32',
    file: 'libraries/tweetnacl/tweetnacl.c',
    edits: [
      ['extern int RNG2(u8 *,u8); //Max size 255',
       'extern int RNG2(u8 *,unsigned); /* must match okcore.cpp:7630 - see stage.js */'],
    ],
  },
  {
    /* The same declaration, the same reason. See the tweetnacl entry above. */
    platform: 'win32',
    file: 'libraries/justhashtweetnacl/justhashtweetnacl.c',
    edits: [
      ['extern int RNG2(u8 *,u8); //Max size 255',
       'extern int RNG2(u8 *,unsigned); /* must match okcore.cpp:7630 - see stage.js */'],
    ],
  },
  {
    /*
     * Rebase the firmware's flash addresses onto OKEMU_FLASH_BASE.
     *
     * The firmware reads its own storage through raw pointers at absolute
     * addresses, which works on Linux because the HAL maps the flash array at
     * address 0 - the MK20DX256's real base. Windows reserves the bottom 64 KB
     * of every process, cannot be persuaded otherwise, and the next rung up
     * leaves certified_hw at 0x5BB0 unmapped, which faults on the first
     * AES-GCM operation. See ok_hal.h.
     *
     * So the origin moves instead. Only four literals exist; everything else
     * in okcore.h derives from them, and every offset and every difference
     * between them is unchanged. On Windows OKEMU_FLASH_BASE is a variable the
     * HAL sets once at init, declared in ok_hal.h.
     *
     * The trailing `//22528 - 23551` on factorysectoradr is deliberately NOT
     * part of the pattern: older firmware releases define the same address
     * with no comment, and a pattern carrying the comment would miss on those
     * while the other three still applied - leaving one address unrebased in a
     * tree that otherwise looks fine. Matching the define alone applies
     * everywhere, and any existing comment simply trails the replacement,
     * which is still valid C.
     */
    platform: 'win32',
    file: 'libraries/onlykey/okcore.h',
    edits: [
      ['#define factorysectoradr 0x5800',
       '#define factorysectoradr (OKEMU_FLASH_BASE + 0x5800)'],
      ['#define fwstartadr 0x6060',
       '#define fwstartadr (OKEMU_FLASH_BASE + 0x6060)'],
      ['#define flashstorestart 0x3A800',
       '#define flashstorestart (OKEMU_FLASH_BASE + 0x3A800)'],
      ['#define flashend 0x3FFFF',
       '#define flashend (OKEMU_FLASH_BASE + 0x3FFFF)'],
    ],
  },
  {
    /*
     * Declarations that disagree with their definitions.
     *
     * The MSVC ABI mangles a global variable's TYPE and LINKAGE into its
     * symbol; the Itanium ABI used on ARM and Linux mangles neither, so a
     * global's symbol is just its name and a wrong declaration still links.
     * These are the ones lld-link caught, each verified against the built
     * objects with llvm-nm rather than assumed:
     *
     *   KeyboardLayout   defined  B KeyboardLayout        C linkage
     *   keyboard_buffer  defined  B keyboard_buffer       C linkage
     *   setBuffer        defined  B setBuffer             C linkage
     *   Profile_Offset   defined  B ?Profile_Offset@@3HA  C++, and it is INT
     *   outputmode       defined  B ?outputmode@@3HA      C++, and it is INT
     *
     * The int/uint8_t pairs are the interesting ones: Profile_Offset is
     * `int Profile_Offset = 0` in okcore.cpp:106, yet password.cpp declares it
     * uint8_t on lines 126 and 296 and int on line 128 - three declarations,
     * two of them wrong, two lines apart. On a little-endian target reading
     * the low byte of an int usually gives the right answer, which is why this
     * has never been noticed.
     *
     * okpqc.cpp carries a comment about exactly this hazard: a
     * packet_buffer_details declared uint32_t against a uint8_t definition
     * gave the wrong stride and produced two confirmed hardware failures. Same
     * class of defect; this time a linker found it first.
     *
     * Windows-scoped for now - all five belong upstream, where fixing them
     * costs nothing on any target and removes a real trap.
     */
    platform: 'win32',
    file: 'libraries/onlykey/okcrypto.cpp',
    edits: [
      /*
       * setBuffer is declared inside a function at :855, and a linkage
       * specification may only appear at namespace scope - `extern "C"` there
       * is a syntax error. Declaring it once up here instead is enough: the
       * block-scope `extern` at :855 then redeclares an entity that already
       * has C linkage and inherits it, so that line needs no edit at all.
       */
      ['extern uint8_t keyboard_buffer[KEYBOARD_BUFFER_SIZE];',
       'extern "C" uint8_t keyboard_buffer[KEYBOARD_BUFFER_SIZE];  /* C linkage: stage.js */\n'
       + 'extern "C" uint8_t setBuffer[9];  /* ditto; declared in-function at :855 */'],
      /*
       * The `outputmode` edit is GONE, because upstream carries it now.
       *
       * okcrypto.cpp declared it `extern uint8_t` while okcore.cpp defines it
       * `int`, and this rewrote the declaration. libraries HEAD already reads
       * `extern int outputmode;   /* defined as int in okcore.cpp ... ` at
       * :174, so the pattern no longer exists and the patch failed to apply -
       * which is a non-zero exit from stage.js, so `npm run stage && node-gyp`
       * stopped before the compiler ever ran.
       *
       * Removed rather than left to warn: this is the same direction as
       * libraries@2ec3a12, which moved the emulator's textual patches
       * in-source precisely because "any whitespace change here silently
       * un-applied a fix". A patch upstream has absorbed is one fewer thing
       * that can un-apply.
       */
    ],
  },
  /*
   * BUTTON PRESSES THAT WORK ON A PRODUCTION BUILD. Ported from ok-rn's
   * android/okemu/scripts/stage.js, where it was measured and proven.
   *
   * The emulator used to press buttons by writing "1#128\n" to the firmware's
   * debug console. That parser is behind `#ifdef DEBUG` and reads a Serial
   * channel a production build does not compile, so on a release build every
   * press - and every GUI control built on one - did nothing at all.
   *
   * This line hands a queued press (src/okemu_press.cpp) straight to the
   * firmware's own dispatch, the way the DEBUG queue does, but compiled
   * unconditionally. okemu_press_take() is declared in shim/okemu_prelude.h,
   * which is force-included, so okcore.cpp gains no #include.
   *
   * The anchor is the dispatch itself, kept to ONE line on purpose: in ok-rn
   * it is byte-identical, unique, and at conditional-compilation depth zero in
   * all nine pinned releases and the working tree. The line after it is none
   * of those - `onlykeyhw==OK_HW_DUO` does not exist on the 2.1 line - so a
   * longer anchor would break the older half of the version matrix.
   *
   * key_press and key_off are function-local statics inside
   * touch_sense_loop(), which is why the hand-over happens in there and why
   * they are passed by pointer. It also runs on the FIRMWARE THREAD, so writing
   * an int the same thread is about to read is safe.
   */
  {
    file: 'libraries/onlykey/okcore.cpp',
    edits: [
      [['\tif ((key_press > 0) && (key_off > 2)) {',
        '    if ((key_press > 0) && (key_off > 2)) {'],   // 3.1.0: four spaces
       '\t/* Injected by emulator/scripts/stage.js - see src/okemu_press.h.\n' +
       '\t   Hands over a queued press when the loop is not already holding\n' +
       '\t   one; does nothing when nothing is queued. */\n' +
       '\tokemu_press_take(&button_selected, &key_press);\n' +
       '\tif ((key_press > 0) && (key_off > 2)) {'],
    ],
  },
  {
    platform: 'win32',
    file: 'libraries/onlykey/okcore.cpp',
    edits: [
      ['extern uint8_t KeyboardLayout[1];',
       'extern "C" uint8_t KeyboardLayout[1];  /* keylayouts.c is C - stage.js */'],
    ],
  },
  /*
   * Profile_Offset and outputmode are NOT retyped any more. These entries used
   * to rewrite their `extern uint8_t` declarations (password.cpp, the sketch)
   * to int, to match the int definition under MSVC mangling. That changed
   * what the firmware reads (a -42 Profile_Offset is 214 through the shipped
   * uint8_t view), and it broke the 2.1 line outright: there the DEFINITION is
   * uint8_t, so the retyped declarations named an int nobody defines. The
   * /alternatename fallbacks in src/ok_hal.cpp now resolve a uint8_t view to
   * an int definition where one exists, and every tree keeps the declarations
   * it shipped with - on every release and on the working tree.
   */
  {
    platform: 'win32',
    file: 'sketch/OnlyKey.ino',
    edits: [
      ['extern uint8_t KeyboardLayout[1];',
       'extern "C" uint8_t KeyboardLayout[1];  /* keylayouts.c is C - stage.js */'],
    ],
  },
  {
    /*
     * okpqc.cpp declares firmware globals without extern "C".
     *
     * Lines 49-70 declare rsa_private_key, large_buffer_offset, outputmode and
     * friends as plain C++ externs. The definitions in okcore.cpp have C
     * linkage, so the names do not match - but only on an ABI that MANGLES
     * VARIABLES. The Itanium C++ ABI does not: a global's symbol is just its
     * name, so ARM and Linux link this happily. MSVC does mangle them, and
     * lld-link reports what was always true:
     *
     *     undefined symbol: int large_buffer_offset
     *       referenced by okpqc.obj          (?large_buffer_offset@@3HA)
     *       defined in    okcore.obj          (large_buffer_offset)
     *
     * The file already spells its FUNCTION imports `extern "C"` a few lines
     * above; the variables were simply missed. Note the comment already in
     * this block about packet_buffer_details, where a declaration that
     * disagreed with its definition produced two confirmed hardware failures -
     * this is the same hazard, caught by a linker instead of by a user.
     *
     * Scoped to Windows only because the Linux build has been shipping this
     * way for years and this patch is not the place to change it. It belongs
     * upstream in okpqc.cpp for every target.
     */
    platform: 'win32',
    file: 'libraries/onlykey/okpqc.cpp',
    edits: [
      /*
       * ONLY these two. The definitions in okcore.cpp are not consistent with
       * one another - llvm-nm on the built objects says so plainly:
       *
       *   large_buffer_offset    B large_buffer_offset         <- C linkage
       *   CRYPTO_AUTH            B CRYPTO_AUTH                 <- C linkage
       *   outputmode             B ?outputmode@@3HA            <- C++
       *   large_buffer           D ?large_buffer@@3PEAEEA      <- C++
       *   ... and six more, all C++
       *
       * so a blanket extern "C" over the whole block only moves the failure
       * to the other eight. Each declaration has to match the linkage of the
       * definition it names, and these are the two that are C.
       */
      ['extern int      large_buffer_offset;',
       'extern "C" int  large_buffer_offset;   /* C linkage: see stage.js */'],
      ['extern uint8_t  CRYPTO_AUTH;',
       'extern "C" uint8_t CRYPTO_AUTH;        /* C linkage: see stage.js */'],
    ],
  },
  {
    /*
     * OnlyKey.ino provides newlib syscall stubs - _getpid, _kill, _write - so
     * that a bare-metal link resolves them. Nothing in the firmware calls any
     * of them; they exist to satisfy newlib.
     *
     * Against a real libc they are redundant, and _write collides outright:
     *
     *     lld-link: error: duplicate symbol: _write
     *       defined at .stage/sketch/OnlyKey.ino:246
     *       defined at libucrt.lib(write.obj)
     *
     * This is the same shape as the recvmsg collision binding.gyp describes -
     * firmware written for a freestanding target reusing names libc owns. On
     * Linux -Bsymbolic resolves it at link time; the Windows toolchain has no
     * equivalent because it never had the problem, so the fix is to stop
     * defining the symbol.
     *
     * Renamed rather than deleted, so the stub stays visible next to its two
     * siblings and nothing looks mysteriously absent. Scoped to Windows
     * because only the UCRT collides - glibc's _write is resolved by
     * -Bsymbolic and the Linux build has been shipping this way for years.
     */
    platform: 'win32',
    file: 'sketch/OnlyKey.ino',
    edits: [
      ['  int _write(){return -1;}',
       '  int okemu_unused_write(){return -1;}  /* renamed: see stage.js */'],
    ],
  },
  {
    file: 'core/Print.h',
    edits: [
      ['\tsize_t println(unsigned long n)\t\t\t{ return print(n) + println(); }',
       '\tsize_t println(unsigned long n)\t\t\t{ return print(n) + println(); }\n'
       + '\tsize_t println(unsigned long long n)\t\t{ return print((unsigned long)n) + println(); }\n'
       + '\tsize_t println(long long n)\t\t\t{ return print((long)n) + println(); }'],
      ['\tsize_t println(unsigned long n, int base)\t{ return print(n, base) + println(); }',
       '\tsize_t println(unsigned long n, int base)\t{ return print(n, base) + println(); }\n'
       + '\tsize_t println(unsigned long long n, int base)\t{ return print((unsigned long)n, base) + println(); }\n'
       + '\tsize_t println(long long n, int base)\t\t{ return print((long)n, base) + println(); }'],
    ],
  },

  /*
   * ---- Ported from ok-rn's base PATCHES for the version matrix ----
   *
   * Every pinned release predates libraries@2ec3a12, which moved the host-build
   * fixes into the firmware behind OK_EMULATOR - so a release needs them from
   * here. They apply to the working tree too where its lines still exist, and
   * are correct there: uintptr_t is right on the MK20DX256 as well, where it is
   * a 32-bit type and nothing changes.
   */
  {
    /*
     * The address of a local, printed by a stack-depth diagnostic under
     * #ifdef DEBUG. uint32_t truncates it on any 64-bit host. Both call sites
     * are the same line, so one edit covers them.
     */
    file: 'libraries/onlykey/okcrypto.cpp',
    edits: [
      [['Serial.println ((uint32_t)&ret);',
        'Serial.println((uint32_t)&ret);'],   // 3.1.0: no space before the paren
       'Serial.println ((uintptr_t)&ret);'],
    ],
  },
  {
    /*
     * A CBOR span measured by casting both ends to uint32_t and subtracting.
     * The subtraction is fine; narrowing the pointers first is not, and on a
     * 64-bit host it can silently produce a bogus length for a buffer that is
     * then bounds-checked against it.
     */
    file: 'libraries/fido2/ctap_parse.cpp',
    edits: [
      ['uint32_t length = (uint32_t)end_byte - (uint32_t)start_byte;',
       'uint32_t length = (uint32_t)((uintptr_t)end_byte - (uintptr_t)start_byte);'],
    ],
  },
  /*
   * webcryptcheck() compares against _appid, which extend_fido2() passes as
   * NULL on the whole CTAP2 route. Releases with a DEBUG early return skip the
   * comparison on a debug build; one without it dereferences NULL. ok-rn
   * measured it from a tombstone (memcmp in webcryptcheck, from
   * ctap_get_assertion). Costs nothing where the early return exists, because
   * the guard is then unreachable. The working tree no longer has the line -
   * working-tree.js declares it absent. ok-rn/FINDING-production-firmware-
   * crashes-in-webcryptcheck.md
   */
  {
    file: 'libraries/fido2/device.cpp',
    edits: [
      ['	appid_match2 = memcmp (stored_appid, _appid, 32);',
       '	appid_match2 = (_appid == NULL) ? 1 : memcmp (stored_appid, _appid, 32);'],
    ],
  },
];

/*
 * Applied only when the staged tree has the DEBUG gate OFF - every signed
 * release as shipped, or a working tree built for production. Ported from
 * ok-rn's DEBUG_OFF_PATCHES; the per-release ones live in each version script.
 *
 * webcryptcheck(): with DEBUG on it returns "trust all origins" before any
 * comparison; with it off, execution reaches the comparisons with the NULL
 * pointers its callers pass (ctap.cpp's allowList walk; extend_fido2()).
 * ok-rn/FINDING-production-firmware-crashes-in-webcryptcheck.md
 */
const NL = String.fromCharCode(10);
const DEBUG_OFF_PATCHES = [
  {
    file: 'libraries/fido2/device.cpp',
    edits: [
      ['    appid_match1 = memcmp (stored_apprpid, rpid, 12);',
       [
         '    /* Injected by emulator/scripts/stage.js wherever the DEBUG gate is',
         '       OFF (ported from ok-rn).',
         '',
         '       Callers pass NULL for both of these. ctap.cpp passes',
         '       webcryptcheck(NULL, NULL); extend_fido2() - the whole CTAP2',
         '       path - passes NULL as _appid on both branches. The #ifdef DEBUG',
         '       early return keeps a debug build from dereferencing them on every',
         '       release that HAS one - see the appid_match2 guard in PATCHES.',
         '',
         '       Guarded per COMPARISON rather than by returning early, so every',
         '       check whose inputs are actually present still runs. The rpid',
         '       check reads ctap_buffer, not _appid, and is the only one the',
         '       CTAP2 path can satisfy. */',
         '    appid_match1 = memcmp (stored_apprpid, rpid, 12);',
       ].join(NL)],
    ],
  },
];

/*
 * Remove Arduino's Time.h from the include path.
 *
 * The Time library ships two headers: TimeLib.h, which has the content, and
 * Time.h, which is one line - `#include "TimeLib.h"`. Its directory has to be
 * on the include path because the firmware includes "Time.h" from several
 * places.
 *
 * On a case-insensitive filesystem - Windows and macOS both - that makes
 * `#include <time.h>` resolve to Arduino's Time.h rather than the C library's,
 * because -I directories are searched before the sysroot. struct timespec then
 * never gets declared, <ctime> finds none of the C time functions, and every
 * file in the HAL that sleeps or reads the clock fails to compile. Linux never
 * sees this, which is why this built there for years and not here.
 *
 * Deleting the one-line shim and pointing its consumers straight at TimeLib.h
 * removes the collision for good rather than per-file. Done on every platform:
 * the result is identical code, and a Linux-only spelling would mean the two
 * trees drift.
 *
 * Ported from ok-rn/android/okemu/scripts/stage.js, which hit this first while
 * building for Android from a Windows host.
 */
/**
 * Rename Crypto/SHA256.h out of the way, the way upstream later did. Ported
 * from ok-rn.
 *
 * THE 2019 TREE HAS TWO HEADERS WHOSE NAMES DIFFER ONLY IN CASE:
 * `Crypto/SHA256.h`, the Arduino Crypto library's C++ class, and
 * `sha256/sha256.h`, Brad Conte's C implementation that defines `SHA256_CTX`.
 * On a case-insensitive filesystem - every Windows checkout - `#include
 * "sha256.h"` from fido2/device.h resolves to whichever directory comes first
 * on the include path, device.h gets the C++ class, and every translation unit
 * that wants SHA256_CTX fails with "unknown type name" (the emulator's Windows
 * matrix, v0.2-beta.8). Upstream fixed it the same way: at libraries HEAD the
 * file is `Crypto/SHA256_2.h`. This renames the STAGED copy for the releases
 * that predate that, and rewrites the includes that name it.
 * @returns how many files were repointed, or -1 when there was nothing to do
 */
function renameCryptoSha256() {
  const dir = path.join(STAGE_LIB, 'Crypto');
  if (!fs.existsSync(dir)) return -1;
  /*
   * `existsSync` is case-INSENSITIVE on Windows and answers true for the
   * already-renamed tree too, so the directory listing is the only honest test
   * of which name is really on disk.
   */
  const names = fs.readdirSync(dir);
  if (!names.includes('SHA256.h')) return -1;

  fs.renameSync(path.join(dir, 'SHA256.h'), path.join(dir, 'SHA256_2.h'));
  if (names.includes('SHA256.cpp')) {
    fs.renameSync(path.join(dir, 'SHA256.cpp'), path.join(dir, 'SHA256_2.cpp'));
  }

  let rewritten = 0;
  const re = /(#\s*include\s*)(["<])SHA256\.h([">])/g;
  const walkAll = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, ent.name);
      if (ent.isDirectory()) { walkAll(q); continue; }
      if (!/\.(c|cpp|h|hpp|ino)$/.test(ent.name)) continue;
      const text = fs.readFileSync(q, 'utf8');
      if (!re.test(text)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      writeFileRetrying(q, text.replace(re, '$1$2SHA256_2.h$3'));
      rewritten++;
    }
  };
  walkAll(STAGE);
  return rewritten;
}

function defuseTimeHeader() {
  const shim = path.join(STAGE_LIB, 'Time', 'Time.h');
  if (fs.existsSync(shim)) fs.rmSync(shim);

  let rewritten = 0;
  const re = /(#\s*include\s*)(["<])Time\.h([">])/g;

  const walkAll = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walkAll(p); continue; }
      if (!/\.(c|cpp|h|hpp|ino)$/.test(ent.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!re.test(text)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      writeFileRetrying(p, text.replace(re, '$1$2TimeLib.h$3'));
      rewritten++;
    }
  };
  walkAll(STAGE);
  return rewritten;
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

/* ------------------------------------------------ the DEBUG gate
 *
 * Ported from ok-rn. `#define DEBUG` is at onlykey.h:81 in the firmware
 * SOURCE, not a build option, and every pinned release's source has it LIVE -
 * the signed images were built with it off. So staging a release as its
 * source reads produces a DEBUG build, which reports "-test", and
 * node-onlykey-lib then reads that as the development tree: a v3.0.4 "-test"
 * key claims postQuantum and xwingDerive, which the real v3.0.4 does not have.
 *
 *     (unset)              a pinned release: OFF, as it was signed
 *                          the working tree: as its source has it
 *     OKEMU_PRODUCTION=1   force it OFF, the way the firmware ships
 *     OKEMU_DEBUG=1        force it ON (the DEBUG console, e.g. to watch
 *                          presses); the device then reports "-test"
 */
function wantDebug(release) {
  if (process.env.OKEMU_DEBUG === '1') return true;
  if (process.env.OKEMU_PRODUCTION === '1') return false;
  return release.pins ? false : null;
}

/**
 * Set - or just read - the DEBUG gate in the staged onlykey.h.
 *
 * A TOGGLE rather than a text patch, because the sources arrive on either side
 * of it, and a patch written for one silently misses in the other. This finds
 * whichever spelling is there and reports the state it leaves.
 *
 * DEBUG_CTAP_VERBOSE is a separate define only newer trees carry, and it
 * follows DEBUG down: leaving it defined would keep printing to a console a
 * production build does not have. It is never turned ON - it floods.
 * @param {boolean|null} want  true for DEBUG, false for production, null as is
 * @returns {boolean|null} whether the staged tree ends up with DEBUG defined
 */
function gateDebug(want) {
  const target = path.join(STAGE_LIB, 'onlykey', 'onlykey.h');
  const ON = '#define DEBUG //Enable Serial Monitor';
  const OFF = '//#define DEBUG //Enable Serial Monitor';

  let text = fs.readFileSync(target, 'utf8');

  /* OFF contains ON as a substring, so it has to be tested first. */
  let on;
  if (text.includes(OFF)) on = false;
  else if (text.includes(ON)) on = true;
  else {
    console.error(
      'stage: WARNING - the DEBUG define is not where it has always been in ' +
      'libraries/onlykey/onlykey.h, so the build gate could not be read.');
    process.exitCode = 1;
    return null;
  }

  if (want === null || want === on) {
    console.log(`stage: DEBUG gate is ${on ? 'ON' : 'OFF'} as the sources have it`);
    return on;
  }

  text = want
    ? text.split(OFF).join(ON + ' - re-enabled by stage.js (OKEMU_DEBUG=1)')
    : text.split(ON).join('//#define DEBUG - removed by stage.js: a production build');

  /* Only ever downwards, and only where the tree has it. */
  if (!want) {
    const verbose = /^#define DEBUG_CTAP_VERBOSE.*$/m;
    if (verbose.test(text)) {
      text = text.replace(verbose,
        '//#define DEBUG_CTAP_VERBOSE - removed with DEBUG; it prints to a ' +
        'console a production build does not have');
    }
  }

  writeFileRetrying(target, text);
  console.log(`stage: DEBUG gate turned ${want ? 'ON' : 'OFF'} (was ${on ? 'ON' : 'OFF'})`);
  return want;
}

/**
 * Keep core/keylayouts.h on the same side of the gate as onlykey.h.
 *
 * The header asks for this itself - "keep it in sync manually". With
 * KEYLAYOUTS_DEBUG_BUILD defined, only US English compiles and every other
 * layout types nothing. Reported either way, never fatal: a release old
 * enough to predate the switch is a fact about that release.
 * @param {boolean|null} debugOn  what the DEBUG gate ended up as
 */
function gateKeylayouts(debugOn) {
  if (debugOn === null) return null;

  const target = path.join(STAGE_CORE, 'keylayouts.h');
  if (!fs.existsSync(target)) return null;

  const ON = '#define KEYLAYOUTS_DEBUG_BUILD';
  const OFF = '//#define KEYLAYOUTS_DEBUG_BUILD';

  let text = fs.readFileSync(target, 'utf8');
  const on = text.includes(OFF) ? false : text.includes(ON) ? true : null;
  if (on === null) {
    console.log('stage: keylayouts.h has no KEYLAYOUTS_DEBUG_BUILD switch at this pin');
    return null;
  }
  if (on === debugOn) return on;

  text = debugOn
    ? text.split(OFF).join(ON + ' - re-enabled by stage.js to match the DEBUG gate')
    : text.split(ON).join(OFF + ' - removed by stage.js to match the DEBUG gate');
  writeFileRetrying(target, text);
  console.log(`stage: keyboard layouts ${debugOn ? 'US English only' : 'ALL ENABLED'} ` +
    '- synced to the DEBUG gate');
  return debugOn;
}

/* ------------------------------------------------ staging a RELEASED version
 *
 * Ported from ok-rn's android/okemu/scripts/stage.js, where the version matrix
 * was built and proven.
 *
 *     OKEMU_VERSION=v3.0.4 npm run stage
 *
 * The commits come from ok-versions.json, which pins `libraries` and
 * `OnlyKey-Firmware` per release; everything else a release needs comes from
 * its own script in scripts/versions/.
 */
const versions = require('./versions');

/**
 * Unpack one commit's tree into `dest`.
 *
 * Two git calls total, not one per file. `ls-tree -r` names every blob and
 * `cat-file --batch` streams all their contents through a single process -
 * which matters because `libraries` is several hundred files, and several
 * hundred process spawns on Windows is a minute of nothing happening.
 */
function materialise(repo, sha, dest) {
  const { execFileSync } = require('child_process');
  const git = (args, opts) => execFileSync('git', ['-C', repo, ...args], {
    maxBuffer: 1 << 30, windowsHide: true, ...opts,
  });

  let listing;
  try {
    listing = git(['ls-tree', '-r', '-z', sha], { encoding: 'utf8' });
  } catch (e) {
    throw new Error(
      `cannot read ${sha} from ${repo}. The commit may not be in this checkout ` +
      `- ok-versions.json pins releases that a fork may not carry.`,
    );
  }

  /* -z gives NUL-terminated records of "<mode> <type> <sha>\t<path>". */
  const entries = [];
  for (const record of listing.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [, type, blob] = record.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;      // submodules and trees are not files
    entries.push({ blob, file: record.slice(tab + 1) });
  }
  if (!entries.length) throw new Error(`${sha} in ${repo} has no files`);

  /* No encoding: the blobs are binary, so the output must stay a Buffer. */
  const batch = git(['cat-file', '--batch'], {
    input: entries.map((e) => e.blob).join('\n') + '\n',
  });

  /*
   * The batch stream is "<sha> <type> <size>\n<contents>\n" per object, and the
   * contents are BINARY - parsed as a Buffer with explicit offsets rather than
   * split on newlines, which would corrupt any file containing one.
   */
  let at = 0;
  for (const entry of entries) {
    const nl = batch.indexOf(0x0a, at);
    const header = batch.slice(at, nl).toString('utf8');
    const size = Number(header.split(' ')[2]);
    const start = nl + 1;

    const target = path.join(dest, entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileRetrying(target, batch.slice(start, start + size));

    at = start + size + 1;              // trailing newline after each object
  }
  return entries.length;
}

/**
 * Point FW and LIB_SRC at a released version's sources.
 *
 * Cached by commit, so switching back and forth across a matrix run costs one
 * extraction each rather than one per build.
 */
function materialiseVersion(release) {
  const { version, pins } = release;
  const out = {};

  for (const [repo, sha] of [
    ['OnlyKey-Firmware', pins['OnlyKey-Firmware']],
    ['libraries', pins.libraries],
  ]) {
    const dest = path.join(VERSION_CACHE, version, repo);
    const stamp = path.join(dest, '.commit');

    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === sha) {
      out[repo] = dest;
      console.log(`stage: ${repo}@${sha} already unpacked`);
      continue;
    }

    rmrf(dest);
    fs.mkdirSync(dest, { recursive: true });
    const count = materialise(path.join(CHECKOUTS, repo), sha, dest);
    writeFileRetrying(stamp, sha + '\n');
    out[repo] = dest;
    console.log(`stage: ${repo}@${sha} unpacked, ${count} files`);
  }

  FW = out['OnlyKey-Firmware'];
  LIB_SRC = out.libraries;
}

/**
 * Copy one file, retrying a Windows lock.
 *
 * EBUSY here is not a broken build, it is another process holding the file for
 * a moment - a watcher, an indexer, an antivirus scan of a tree that was just
 * rewritten. In ok-rn it took down a matrix sweep twice, reported as a stage
 * failure with no hint that waiting would have fixed it; both times the very
 * next attempt succeeded. So: a few short retries, then the original error.
 * Synchronous on purpose - everything around it is.
 */
function retryingLock(fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      const transient = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
      if (!transient || i >= attempts) throw e;
      const until = Date.now() + 60 * i;
      while (Date.now() < until) { /* hold: no event loop to await on */ }
    }
  }
}

function copyFileRetrying(src, dst) {
  return retryingLock(() => fs.copyFileSync(src, dst));
}

/*
 * WRITES NEED IT TOO. The emulator's matrix hit exactly this on Windows: EBUSY
 * opening .stage/libraries/onlykey/okcore.cpp for the patch write, twice, each
 * time when the working tree was staged straight after a release - the copy
 * had just landed and something (an indexer, a scanner) still held it. Every
 * staged-file write in this script goes through here.
 */
function writeFileRetrying(file, data) {
  return retryingLock(() => fs.writeFileSync(file, data));
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else copyFileRetrying(s, d);
  }
}

const firstLine = (s) => String(s).split(/\r?\n/)[0].trim();

/**
 * Apply PATCHES, then the release's own patches (`extra`).
 *
 * Ported from ok-rn's stage.js, with the emulator's platform filter kept.
 * A missed pattern sets a non-zero exit, and `npm run stage && node-gyp ...`
 * then stops before the compiler runs - a patch that silently fails to apply
 * is worse than one that errors.
 *
 * @param {Array} extra    the release's patches, applied after the base ones
 * @param {Array} absent   files or patterns the release DECLARES it lacks
 */
function applyPatches(extra = [], absent = []) {
  let applied = 0, missing = 0, expected = 0;
  const patches = [...PATCHES, ...extra];
  /*
   * SOME BASE PATCHES DO NOT APPLY TO EVERY RELEASE, and for an old enough tree
   * that is a fact about the release rather than a fault (okpqc.cpp exists in
   * no release at all; the 2019 beta has no factorysectoradr). So a release may
   * DECLARE a file or pattern absent. Declared-absent is counted and reported -
   * it is not silence - and one declared absent that turns out to be PRESENT
   * throws, because the tree would be built unpatched on a stale claim.
   */
  const declaredAbsent = new Set(absent);
  const seen = new Set();
  for (const p of patches) {
    /*
     * A patch may be scoped to one host platform. Used sparingly - a fix that
     * is correct everywhere should apply everywhere, so the trees do not
     * drift - but some collisions only exist against one libc, and silently
     * changing the Linux build to fix Windows would be worse than the drift.
     *
     * Skipped for the platform still counts as LOOKED FOR: a release declares
     * absent what any platform's patch wants, and the stale-declaration check
     * below must not fire on Linux over a Windows-only patch.
     */
    if (p.platform && p.platform !== process.platform) {
      seen.add(p.file);
      for (const [from] of p.edits) seen.add(from);
      continue;
    }
    const target = path.join(STAGE, p.file);
    if (!fs.existsSync(target)) {
      if (declaredAbsent.has(p.file)) {
        console.log(`stage: ${p.file} is absent at this pin, as its release says`);
        seen.add(p.file);
        expected++;
        continue;
      }
      console.error(`stage: WARNING - patch file absent: ${p.file}`);
      missing++;
      continue;
    }
    let text = fs.readFileSync(target, 'utf8');
    for (const [fromSpec, to] of p.edits) {
      /*
       * A checkout cloned on Windows stages with CRLF while the patterns are
       * written with LF. Try the pattern as written, then with CRLF line
       * endings, and keep whichever matches.
       *
       * `from` may also be a LIST of spellings of the same line, tried in
       * order. Release 3.1.0 re-indented and re-spaced the sources (a tab
       * became four spaces in touch_sense_loop(), "Serial.println ((" became
       * "Serial.println((") and the exact-text patterns stopped matching,
       * while every older release still spells them the old way. A list keeps
       * each spelling exact - a loose whitespace match could land a patch
       * somewhere it was never meant to go - and the FIRST spelling names the
       * edit, for absentPatterns and the warnings.
       */
      const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
      const froms = Array.isArray(fromSpec) ? fromSpec : [fromSpec];
      const from = froms[0];
      let from2 = null;
      for (const cand of froms) {
        if (text.includes(cand)) { from2 = cand; break; }
        if (text.includes(crlf(cand))) { from2 = crlf(cand); break; }
      }
      if (from2 === null) {
        if (declaredAbsent.has(from)) {
          seen.add(from);
          expected++;
          continue;
        }
        console.error(
          `stage: WARNING - pattern not found in ${p.file}: ${firstLine(from)}` +
          ' | if this release predates it, list that line in the version ' +
          "script's `absentPatterns`");
        missing++;
        continue;
      }
      if (declaredAbsent.has(from)) {
        throw new Error(
          `stage: ${p.file} DOES contain a pattern its release declares ` +
          `absent: ${firstLine(from)} | remove it from absentPatterns - the ` +
          'tree would be left unpatched on the strength of a stale claim');
      }
      text = text.split(from2).join(from2.includes('\r\n') ? crlf(to) : to);
      applied++;
    }
    writeFileRetrying(target, text);
  }
  for (const declared of declaredAbsent) {
    if (!seen.has(declared)) {
      throw new Error(
        'stage: this release declares a pattern absent that no patch looks ' +
        `for: ${firstLine(declared)} | either a typo, or the patch it ` +
        'belonged to has gone');
    }
  }
  if (expected) {
    console.log(`stage: ${expected} patch edit(s) absent at this pin, as declared`);
  }
  if (missing) {
    console.error(
      'stage: a patch did not apply - upstream may have changed. Review PATCHES.'
    );
    process.exitCode = 1;
  }
  return applied;
}

/*
 * Rewrite the register blocks out of the staged sources - NO FIXED ADDRESSES.
 *
 * Every register in kinetis.h is a literal absolute address:
 *
 *     #define FTFL_FSEC  (*(const uint8_t *)0x40020002)
 *     #define SYST_CVR   (*(volatile uint32_t *)0xE000E018)
 *
 * This emulator used to mmap those windows at their real addresses, which is
 * a bet against whatever the host runtime put there first - and it was lost:
 * the bit-band alias collided with V8's heap and crash-looped the daemon, and
 * ok-rn's copy of this HAL could not start on a phone whose runtime reserves
 * 0x40000000 (see src/okemu_regs.cpp). So both blocks are ordinary arrays and
 * every register is redirected into them: the arithmetic still resolves at
 * compile time against the array, so the generated code is the same shape it
 * always was.
 *
 * ONE PATTERN FOR EVERY SHAPE. Register casts come as `volatile`/`const`,
 * with uneven spacing (`uint8_t  *`), as struct types (KINETIS_MCG_t), as the
 * DMA `volatile const void * volatile *`, and inside the NVIC macros that do
 * pointer arithmetic on a bare cast. So this matches the CAST,
 * `(<type> *)0xAAAAAAAA`, wherever it appears, and wraps only the literal:
 *
 *     (*(const uint8_t *)0x40020002)   ->  (*(const uint8_t *)OKEMU_PBRIDGE(0x40020002))
 *     ((volatile uint32_t *)0xE000E100 + n)  ->  ((volatile uint32_t *)OKEMU_SCS(0xE000E100) + n)
 *
 * Blanket, not targeted: only ~15 registers are really used, but a future
 * firmware revision reaching a new one must not fault on some host.
 *
 * And then CHECKED. Anything that still casts a bridge or system-block
 * literal afterwards - in kinetis.h or in any staged source - fails the
 * stage, so a new raw hardware address breaks the BUILD rather than a host
 * that happens to have something mapped there. okcore.h's CPU_RESTART_ADDR is
 * one such literal outside kinetis.h; it is rewritten by the same pass.
 *
 * A header's own #define always wins over anything predefined from outside, so
 * this cannot be done with -D or a force-included shim. Patching the staged
 * copy is the only lever, exactly as it is for the CPSID asm above.
 *
 * Ported from ok-rn/android/okemu/scripts/stage.js.
 */
const REGISTER_BLOCKS = [
  { name: 'peripheral bridge', base: 0x40000000, len: 0x00100000,
    macro: 'OKEMU_PBRIDGE', array: 'okemu_pbridge_base' },
  { name: 'system block', base: 0xE0000000, len: 0x00100000,
    macro: 'OKEMU_SCS', array: 'okemu_scs_base' },
];

/* `(<type> *)0xAAAAAAAA` - a type that starts with a name and ends in `*`,
 * with anything but parentheses between (spaces, const, `* volatile`). */
const CAST_LITERAL = /\(([A-Za-z_][^()]*?\*)\)\s*(0x[0-9A-Fa-f]{8})\b/g;

/* Arduino libraries binding.gyp includes straight from the install. */
const UNSTAGED_INCLUDE_LIBS = ['EEPROM', 'ADC'];

function registerBlockFor(address) {
  return REGISTER_BLOCKS.find(b => address >= b.base && address < b.base + b.len);
}

/* Casts of a block address still left in `text` (comment lines skipped). */
function rawRegisterCasts(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\/?\*)/.test(line)) return;
    for (const m of line.matchAll(CAST_LITERAL)) {
      if (registerBlockFor(parseInt(m[2], 16))) hits.push({ line: i + 1, text: line.trim() });
    }
  });
  return hits;
}

function rewriteRegisterBlocks() {
  const target = path.join(STAGE_CORE, 'kinetis.h');
  let text = fs.readFileSync(target, 'utf8');

  const counts = Object.fromEntries(REGISTER_BLOCKS.map(b => [b.name, 0]));
  const rebase = (whole, type, addr) => {
    const block = registerBlockFor(parseInt(addr, 16));
    if (!block) return whole;       /* 0xF8.. / 0xF0003.. : Teensy LC only */
    counts[block.name]++;
    return `(${type})${block.macro}(${addr})`;
  };
  text = text.replace(CAST_LITERAL, rebase);

  for (const b of REGISTER_BLOCKS) {
    if (!counts[b.name]) {
      console.error(`stage: WARNING - no ${b.name} registers rewritten`);
      process.exitCode = 1;
      return counts;
    }
  }

  /*
   * The macros have to be visible before the first use. kinetis.h opens with an
   * include guard; put the declarations immediately after it so every consumer
   * of the header gets them, in whatever order they include things.
   *
   * Matched as a regex rather than a literal: checkouts cloned on Windows
   * carry CRLF, and a multi-line literal would silently fail to match.
   *
   * #ifndef-guarded because src/ok_hal.h defines the same two macros for the
   * HAL's own register accesses, and a translation unit may see both.
   */
  const anchor = /#ifndef\s+_kinetis_h_\r?\n#define\s+_kinetis_h_\r?\n/;
  if (!anchor.test(text)) {
    console.error('stage: WARNING - kinetis.h include guard not where expected');
    process.exitCode = 1;
    return counts;
  }
  const decl =
    '\n/* Injected by emulator/scripts/stage.js - see rewriteRegisterBlocks(). */\n' +
    '#ifdef __cplusplus\nextern "C" {\n#endif\n' +
    REGISTER_BLOCKS.map(b => `extern unsigned char ${b.array}[0x${b.len.toString(16).toUpperCase()}];\n`).join('') +
    /* Bit-band: nothing compiled uses it, and there is no alias region any
     * more. Declared, never defined - see the avr_emulation.h patch. */
    'extern unsigned long okemu_bitband_unsupported(void);\n' +
    '#ifdef __cplusplus\n}\n#endif\n' +
    REGISTER_BLOCKS.map(b =>
      `#ifndef ${b.macro}\n` +
      `#define ${b.macro}(a) ((void *)(${b.array} + ((uintptr_t)(a) - 0x${b.base.toString(16).toUpperCase()}UL)))\n` +
      '#endif\n').join('') +
    '\n';
  text = text.replace(anchor, (m) => m + decl);
  writeFileRetrying(target, text);

  /*
   * EVERY STAGED SOURCE, not just kinetis.h. Libraries carry their own copies
   * of register definitions (ok-rn's first run of the check below found
   * InternalTemperature.h defining SIM_SDID as a raw
   * `*(const uint32_t *)0x40048024`), and okcore.h has CPU_RESTART_ADDR. They
   * all see the macros through kinetis.h (every Arduino translation unit
   * includes it); a file that did not would fail to COMPILE, which is the
   * safe direction.
   */
  const sources = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (/\.(c|cpp|h|hpp|ino)$/i.test(ent.name) && full !== target) sources.push(full);
    }
  };
  walk(STAGE_CORE);
  walk(STAGE_LIB);
  walk(STAGE_SKETCH);
  for (const full of sources) {
    const before = fs.readFileSync(full, 'utf8');
    const after = before.replace(CAST_LITERAL, rebase);
    if (after !== before) writeFileRetrying(full, after);
  }

  /* The check: anything still casting a block address fails the stage. */
  const leftovers = rawRegisterCasts(text).map(h => `core/kinetis.h:${h.line}: ${h.text}`);
  for (const full of sources) {
    for (const h of rawRegisterCasts(fs.readFileSync(full, 'utf8'))) {
      leftovers.push(`${path.relative(STAGE, full)}:${h.line}: ${h.text}`);
    }
  }
  /*
   * AND THE HEADERS THE BUILD TAKES FROM OUTSIDE THE STAGE. binding.gyp puts
   * two libraries of the Arduino install on the include path unstaged (EEPROM,
   * ADC), so nothing above rewrites them - and they are shared with every
   * other build on the machine, so this does not either. It only CHECKS them:
   * a raw register address there would compile against memory nothing backs.
   * The fix for a hit is to stage that library and let the pass above rewrite
   * it. (Found by compiling the firmware without -w: ADC_Module.h is included
   * this way. It names no register by address today - only the bit-band
   * macro, inside inline members nothing calls.)
   */
  for (const lib of UNSTAGED_INCLUDE_LIBS) {
    const dir = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'libraries', lib);
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir)) {
      if (!/\.(h|hpp)$/i.test(ent)) continue;
      for (const h of rawRegisterCasts(fs.readFileSync(path.join(dir, ent), 'utf8'))) {
        leftovers.push(`(Arduino install, unstaged) libraries/${lib}/${ent}:${h.line}: ${h.text}`);
      }
    }
  }
  if (leftovers.length) {
    console.error('stage: ERROR - a raw hardware register address survived the rewrite.\n' +
      '  The emulator must not depend on a fixed address (it collides with the\n' +
      '  host runtime). Rebase these onto OKEMU_PBRIDGE / OKEMU_SCS:\n' +
      leftovers.slice(0, 20).map(l => `    ${l}`).join('\n'));
    process.exitCode = 1;
  }
  return counts;
}

function main() {
  /*
   * EVERY build has a version script, the working tree included (as in ok-rn):
   * it says which patches this particular source tree needs. OKEMU_VERSION
   * picks a release; unset is the working tree.
   *
   * Repoint FW and LIB_SRC BEFORE anything reads them, including the existence
   * check below - so a missing pinned commit fails naming the commit, not the
   * checkout.
   */
  let release;
  try {
    release = versions.load(process.env.OKEMU_VERSION || versions.WORKING_TREE);
  } catch (e) {
    console.error(`stage: ${e.message}`);
    process.exit(1);
  }
  /*
   * A release whose script says it cannot be staged ON THIS PLATFORM stops
   * here, quoting its notes - rather than producing a tree under a version
   * number every later measurement would be attached to.
   */
  if (release.status === 'blocked') {
    console.error(`stage: ${release.version} is marked BLOCKED for ` +
      `${versions.EMULATOR_PLATFORM} in its version script.`);
    console.error(String(release.notes).replace(/^/gm, '  '));
    process.exit(1);
  }
  if (release.pins) materialiseVersion(release);
  console.log(`stage: ${release.version} (emulator ${versions.EMULATOR_PLATFORM}: ${release.status})`);

  for (const p of [CORE_SRC, FW, LIB_SRC]) {
    if (!fs.existsSync(p)) {
      console.error(`stage: missing required tree: ${p}`);
      process.exit(1);
    }
  }

  rmrf(STAGE);

  // 1. stock teensy3 core
  copyDir(CORE_SRC, STAGE_CORE);

  // 2. OnlyKey's composite USB stack + keylayouts shadow the stock core files
  let overlaid = 0;
  for (const f of fs.readdirSync(FW)) {
    if (/\.(c|h)$/.test(f)) {
      copyFileRetrying(path.join(FW, f), path.join(STAGE_CORE, f));
      overlaid++;
    }
  }

  // 3. our host implementations of the peripheral drivers
  let overrides = 0;
  if (fs.existsSync(OVERRIDE)) {
    for (const f of fs.readdirSync(OVERRIDE)) {
      if (/\.(c|cpp|h)$/.test(f)) {
        copyFileRetrying(path.join(OVERRIDE, f), path.join(STAGE_CORE, f));
        overrides++;
      }
    }
  }

  // 4. drop the bare-metal files
  let dropped = 0;
  for (const f of DROP) {
    const p = path.join(STAGE_CORE, f);
    if (fs.existsSync(p)) { fs.rmSync(p); dropped++; }
  }

  // 5. vendored libraries and the sketch
  copyDir(LIB_SRC, STAGE_LIB);
  /*
   * WHERE THE SKETCH LIVES IS PER-RELEASE (ported from ok-rn). Every release
   * from v2.1.0 on keeps it at OnlyKey/OnlyKey.ino, but the 2019 beta line has
   * OnlyKey_Beta/OnlyKey_Beta.ino - a different directory AND file name. It is
   * staged AS OnlyKey.ino either way, because src/okemu_sketch.cpp includes
   * that name, and the name is not the part that varies between releases.
   */
  const sketch = release.sketch || { dir: 'OnlyKey', file: 'OnlyKey.ino' };
  copyDir(path.join(FW, sketch.dir), STAGE_SKETCH);
  if (sketch.file !== 'OnlyKey.ino') {
    const from = path.join(STAGE_SKETCH, sketch.file);
    if (!fs.existsSync(from)) {
      throw new Error(
        `stage: ${release.version} names its sketch ${sketch.dir}/${sketch.file}, ` +
        'which is not in the checkout at this pin');
    }
    fs.renameSync(from, path.join(STAGE_SKETCH, 'OnlyKey.ino'));
  }

  /*
   * Arduino's Time library is staged rather than included from the Arduino
   * checkout, so that defuseTimeHeader() below has somewhere to delete Time.h
   * from. Leaving it in place would mean editing the Arduino tree, which is
   * shared with every other build on this machine.
   */
  copyDir(path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'libraries', 'Time'),
          path.join(STAGE_LIB, 'Time'));
  const timeRepointed = defuseTimeHeader();
  const shaRenamed = renameCryptoSha256();
  if (shaRenamed >= 0) console.log(`stage: Crypto/SHA256.h staged as SHA256_2.h, ${shaRenamed} include(s) repointed`);

  // 6. documented source-level fixups
  /*
   * The release's own patches, and - when the staged tree ships with DEBUG
   * off, as every signed release does - its debug-off patches: lines that
   * only exist, or only misbehave, once the console is compiled out.
   */
  const debugOn = gateDebug(wantDebug(release));
  gateKeylayouts(debugOn);
  /*
   * okpqc.cpp (the post-quantum code) exists in no pinned release - it is
   * newer than all of them - so the emulator's win32 patch for it is declared
   * absent for every pinned tree here rather than in nine version scripts. If
   * a later release does ship it, applyPatches() throws on the stale claim.
   */
  const pinnedAbsent = release.pins ? ['libraries/onlykey/okpqc.cpp'] : [];
  const patched = applyPatches(
    [...release.patches, ...(debugOn ? [] : [...DEBUG_OFF_PATCHES, ...release.debugOffPatches])],
    [...release.absentPatterns, ...pinnedAbsent,
     ...(debugOn ? [] : release.debugOffAbsentPatterns)],
  );
  console.log(`stage: DEBUG console ${debugOn ? 'on' : 'off'} in this tree`);

  // 7. no fixed addresses: registers into the relocated blocks, then checked
  const registerCounts = rewriteRegisterBlocks();

  /*
   * 8. Say what was staged. The addon built from this tree does not know which
   * release it is, and a test that checks a release against its row in
   * ok-versions.json (test/compat.js) has to - reading OKEMU_VERSION from its
   * own environment would trust the caller rather than the build.
   */
  writeFileRetrying(path.join(STAGE, 'build.json'), JSON.stringify({
    version: release.version,
    pins: release.pins ? { libraries: release.pins.libraries,
      'OnlyKey-Firmware': release.pins['OnlyKey-Firmware'] } : null,
    debug: debugOn,
    platform: versions.EMULATOR_PLATFORM,
  }, null, 2) + '\n');

  console.log(
    `stage: ${path.relative(ROOT, STAGE)}\n` +
    `  core files overlaid from OnlyKey-Firmware: ${overlaid}\n` +
    `  emulator overrides applied:                ${overrides}\n` +
    `  bare-metal files dropped:                  ${dropped}\n` +
    `  Time.h consumers repointed at TimeLib.h:   ${timeRepointed}
` +
    `  source patches applied:                    ${patched}
` +
    `  registers rebased (no fixed addresses):    ` +
    Object.entries(registerCounts).map(([n, c]) => `${n} ${c}`).join(', ')
  );
}

main();
