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
const FW = path.join(CHECKOUTS, 'OnlyKey-Firmware');
const LIB_SRC = path.join(CHECKOUTS, 'libraries');
const OVERRIDE = path.join(EMU, 'core-override');

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
      ['extern uint8_t outputmode;',
       'extern int outputmode;   /* okcore.cpp:276 defines it int - stage.js */'],
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
  {
    platform: 'win32',
    file: 'libraries/password/password.cpp',
    /* Both occurrences; line 128 already says int and needs no edit. */
    edits: [
      ['\textern uint8_t Profile_Offset;',
       '\textern int Profile_Offset;   /* okcore.cpp:106 defines it int - stage.js */'],
    ],
  },
  {
    platform: 'win32',
    file: 'sketch/OnlyKey.ino',
    edits: [
      ['extern uint8_t Profile_Offset;',
       'extern int Profile_Offset;   /* okcore.cpp:106 defines it int - stage.js */'],
      ['extern uint8_t KeyboardLayout[1];',
       'extern "C" uint8_t KeyboardLayout[1];  /* keylayouts.c is C - stage.js */'],
      ['extern uint8_t outputmode;',
       'extern int outputmode;   /* okcore.cpp:276 defines it int - stage.js */'],
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
      fs.writeFileSync(p, text.replace(re, '$1$2TimeLib.h$3'));
      rewritten++;
    }
  };
  walkAll(STAGE);
  return rewritten;
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function applyPatches() {
  let applied = 0, missing = 0;
  for (const p of PATCHES) {
    /*
     * A patch may be scoped to one host platform. Used sparingly - a fix that
     * is correct everywhere should apply everywhere, so the trees do not
     * drift - but some collisions only exist against one libc, and silently
     * changing the Linux build to fix Windows would be worse than the drift.
     */
    if (p.platform && p.platform !== process.platform) continue;
    const target = path.join(STAGE, p.file);
    if (!fs.existsSync(target)) {
      console.error(`stage: WARNING - patch file absent: ${p.file}`);
      missing++;
      continue;
    }
    let text = fs.readFileSync(target, 'utf8');
    for (const [from, to] of p.edits) {
      if (!text.includes(from)) {
        console.error(`stage: WARNING - pattern not found in ${p.file}: ${from}`);
        missing++;
        continue;
      }
      text = text.split(from).join(to);
      applied++;
    }
    fs.writeFileSync(target, text);
  }
  if (missing) {
    console.error(
      'stage: a patch did not apply - upstream may have changed. Review PATCHES.'
    );
    process.exitCode = 1;
  }
  return applied;
}

function main() {
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
      fs.copyFileSync(path.join(FW, f), path.join(STAGE_CORE, f));
      overlaid++;
    }
  }

  // 3. our host implementations of the peripheral drivers
  let overrides = 0;
  if (fs.existsSync(OVERRIDE)) {
    for (const f of fs.readdirSync(OVERRIDE)) {
      if (/\.(c|cpp|h)$/.test(f)) {
        fs.copyFileSync(path.join(OVERRIDE, f), path.join(STAGE_CORE, f));
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
  copyDir(path.join(FW, 'OnlyKey'), STAGE_SKETCH);

  /*
   * Arduino's Time library is staged rather than included from the Arduino
   * checkout, so that defuseTimeHeader() below has somewhere to delete Time.h
   * from. Leaving it in place would mean editing the Arduino tree, which is
   * shared with every other build on this machine.
   */
  copyDir(path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'libraries', 'Time'),
          path.join(STAGE_LIB, 'Time'));
  const timeRepointed = defuseTimeHeader();

  // 6. documented source-level fixups
  const patched = applyPatches();

  console.log(
    `stage: ${path.relative(ROOT, STAGE)}\n` +
    `  core files overlaid from OnlyKey-Firmware: ${overlaid}\n` +
    `  emulator overrides applied:                ${overrides}\n` +
    `  bare-metal files dropped:                  ${dropped}\n` +
    `  Time.h consumers repointed at TimeLib.h:   ${timeRepointed}
` +
    `  source patches applied:                    ${patched}`
  );
}

main();
