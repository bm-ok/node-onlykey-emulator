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
 * Nothing under onlykey/ is ever written to.
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
const OK = path.join(ROOT, 'onlykey');
const ARDUINO = path.join(OK, 'arduino-1.6.5-r5-teensy_127', 'arduino-1.6.5-r5');
const CORE_SRC = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'cores', 'teensy3');
const FW = path.join(OK, 'OnlyKey-Firmware');
const LIB_SRC = path.join(OK, 'libraries');
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
 * Everything the FIRMWARE needs in order to build and run on a host should end
 * up in the OnlyKey sources under `#ifdef OK_EMULATOR`, or - where the fix was
 * correct on the MK20DX256 too - as an unconditional correction. See the
 * README section "Running 32-bit firmware on a 64-bit host". A gate in the
 * source is more robust than a patch here, because a patch is a literal string
 * substitution that silently stops applying the moment upstream whitespace
 * moves.
 *
 * One entry is permanent. The vendored Teensy core is not OnlyKey code, and it
 * defines two constructs in terms of Cortex-M inline assembly; a header's own
 * #define always wins over anything predefined from outside, so it cannot be
 * overridden by okemu_prelude.h or by -D. Patching the staged copy is the only
 * lever, and the core stays free of emulator knowledge.
 *
 * ---------------------------------------------------------------------------
 * Rule for agent-authored firmware changes
 * ---------------------------------------------------------------------------
 * Any firmware change proposed by an AI agent lands HERE FIRST, as a patch
 * entry, and is proved out here. It is promoted into the OnlyKey source as an
 * `#ifdef OK_EMULATOR` gate only after it has been built and tested from this
 * list.
 *
 * The reason is ownership, not distrust of the change. The OnlyKey sources
 * under onlykey/ are separate repositories and a deliberate swap slot: any of
 * them can be replaced wholesale with a different fork or revision, and a
 * checkout carrying speculative local edits is no longer swappable. Worse, an
 * edit made directly in firmware that turns out to be wrong has to be found
 * and unpicked across a repo boundary, while an entry here is deleted in one
 * line and leaves nothing behind.
 *
 * So the order is: patch here, stage, build, test, and only then move it into
 * the source behind a gate - at which point the entry here is removed. A patch
 * that has not been through that sequence does not belong in firmware, and
 * firmware is not where an agent should be discovering whether an idea works.
 *
 * applyPatches() is what makes the intermediate state safe: an unmatched
 * pattern warns by name and fails the build, so a stale patch cannot silently
 * produce a binary that looks fine and misbehaves at runtime.
 *
 * ---------------------------------------------------------------------------
 * Patch register
 * ---------------------------------------------------------------------------
 * Every entry carries a `status`, and `npm run stage` prints the provisional
 * ones on every run. The register is here for reading; the `status` field is
 * the authority, so the two cannot drift.
 *
 *   PERMANENT   Stays in this list forever. There is no gate to promote it to.
 *               Adding one needs a reason as strong as the existing entry's.
 *
 *     core/kinetis.h
 *         Vendored Teensy core, not OnlyKey code, so it must not learn about
 *         the emulator. `__disable_irq()`/`__enable_irq()` are defined as
 *         Cortex-M inline assembly, and a header's own #define always wins
 *         over anything predefined from outside - okemu_prelude.h and -D both
 *         lose to it. Patching the staged copy is the only lever there is.
 *
 *     core/Print.cpp
 *         Also vendored Teensy core. Print::printf passes `(int)this` as a
 *         file descriptor, which truncates a 64-bit pointer; on Linux glibc's
 *         vdprintf then writes to a garbage fd and every Serial.printf()
 *         silently vanishes, and on Windows there is no vdprintf to call.
 *         Redirected to okemu_vdprintf(), which keeps the pointer and goes
 *         through Print::write. Same "core must not learn about the emulator"
 *         reasoning, so there is no gate to promote it to either.
 *
 *   PROVISIONAL Being proved out here before it lands in firmware. Promote to
 *               an `#ifdef OK_EMULATOR` gate once built and tested, then
 *               delete the entry. If one of these is still here in six
 *               months, either promote it or write down why it is permanent.
 *
 *     libraries/onlykey/okcore.h
 *         Windows flash shift: the four flash address roots move +0x10000 so
 *         the map clears Windows' reserved low 64 KB. Windows-only, gated on
 *         process.platform. Not yet promoted because it has never been
 *         compiled on Windows - the HAL still calls mmap and sigaction, and
 *         a gate in firmware for a configuration that has never run is a
 *         claim this repo cannot yet make.
 */
/*
 * Windows cannot map the flash array at its real MK20DX256 base.
 *
 * The low 64 KB of user address space is permanently reserved as the
 * null-pointer partition, there is no vm.mmap_min_addr equivalent to lower,
 * and MapViewOfFileEx additionally wants a base aligned to the 64 KB
 * allocation granularity rather than to the page. So ok_hal.h shifts
 * OKEMU_FLASH_BASE up by exactly one granule on Windows, and the firmware's
 * address constants have to move with it or every flash access lands outside
 * the mapping.
 *
 * Why this is exact rather than approximate: every flash address in the
 * firmware derives from the four constants below, so shifting all four
 * together preserves every relative offset. Three things were checked rather
 * than assumed:
 *
 *   - FLASH_SECTOR_SIZE is 0x800 and 0x10000 / 0x800 = 32, so sector alignment
 *     is preserved and FLASH_ALIGN behaves identically.
 *   - FLASH_SIZE (0x3FFFF) is defined but never used - it appears only in
 *     flashkinetis.h and keywords.txt - so there is no bounds check to break.
 *   - flashkinetis.cpp is not compiled at all; okemu_flash.cpp replaces it,
 *     and its guards are written relative to OKEMU_FLASH_BASE.
 *
 * Without it, certified_hw (enckeysectoradr + 432 = 0x5BB0) is unmappable and
 * okcrypto_split_sundae() dereferences it on every AES-GCM operation: the
 * device boots, enumerates and answers HID perfectly, then segfaults on the
 * first thing that encrypts anything. That is the 0x10000 rung
 * onlykey-testing/EXPLAINER.md describes, and on Windows it would be the only
 * rung reachable.
 *
 * On the note above about gating OnlyKey sources in the file itself: that is
 * the better mechanism where the file is ours to change, and it was tried
 * first. It is not available here. okcore.h lives in a separate repository and
 * nothing under onlykey/ may be written to, which is precisely the situation
 * this patch list exists for - the swap slot has to stay swappable, and a
 * checkout carrying local edits is no longer swappable.
 *
 * The brittleness that argues against textual patches is real, and the
 * mitigation is already here: applyPatches() warns by name and sets a failing
 * exit code when a pattern does not match, so an upstream whitespace change
 * fails the build loudly instead of silently producing an unshifted binary
 * that segfaults on first use.
 */
const WINDOWS_FLASH_PATCH = {
  file: 'libraries/onlykey/okcore.h',
  status: 'provisional',
  platform: 'win32',
  note: 'Windows flash shift. Promote to an OK_EMULATOR/_WIN32 gate in '
      + 'okcore.h once a Windows build has been proved out.',
  edits: [
    ['#define factorysectoradr 0x5800 //22528 - 23551',
     '#define factorysectoradr 0x15800 //22528 - 23551, +0x10000 (Windows; see stage.js)'],
    ['#define fwstartadr 0x6060',
     '#define fwstartadr 0x16060'],
    ['#define flashstorestart 0x3A800',
     '#define flashstorestart 0x4A800'],
    ['#define flashend 0x3FFFF',
     '#define flashend 0x4FFFF'],
  ],
};

const PATCHES = [
  {
    file: 'core/kinetis.h',
    status: 'permanent',
    note: 'Vendored Teensy core, not OnlyKey code. A header\'s own #define '
        + 'beats anything predefined from outside, so there is no gate to '
        + 'promote this to. It never leaves this list.',
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
    file: 'libraries/uECC/uECC.c',
    status: 'provisional',
    note: 'uECC_point_mult is called before it is declared. Promote as an '
        + 'unconditional fix in uECC.c - a missing prototype is a bug on '
        + 'every target, not a Windows one.',
    edits: [
      /*
       * uECC_shared_secret2() calls uECC_point_mult() eleven lines before the
       * definition, and the only declaration lives in uECC_vli.h behind
       * `#if uECC_ENABLE_VLI_API`, which defaults to 0 and is set nowhere in
       * this tree. So the call sees no prototype at all.
       *
       * C89 let that slide as an implicit `int uECC_point_mult()`, and GCC
       * still only warns - which the POSIX build's -w hides. clang stops on
       * it twice: once for the implicit declaration, and again because the
       * implicit `int` return conflicts with the real `void` definition. The
       * second one is not a warning and no -Wno- flag silences it.
       *
       * Note the function name: uECC_shared_secret2 is an OnlyKey addition
       * rather than upstream micro-ecc, which is presumably how it was
       * written against an API that is compiled out.
       *
       * Unconditional rather than Windows-gated, because a call with no
       * visible prototype is wrong everywhere. Declaring it is what upstream
       * should do; this is the staged stand-in until it does.
       *
       * PROVISIONAL - see the rule above. This wants to become a real
       * declaration in uECC.c, at which point this entry goes away.
       */
      ['int uECC_shared_secret2(const uint8_t *public_key,',
       '/* Declared here because uECC_vli.h only declares it under\n'
       + ' * uECC_ENABLE_VLI_API, which is 0. Added by the emulator\'s stage\n'
       + ' * patch - see emulator/scripts/stage.js. */\n'
       + 'void uECC_point_mult(uECC_word_t *result,\n'
       + '                     const uECC_word_t *point,\n'
       + '                     const uECC_word_t *scalar,\n'
       + '                     uECC_Curve curve);\n'
       + '\n'
       + 'int uECC_shared_secret2(const uint8_t *public_key,'],
    ],
  },

  {
    file: 'core/Print.h',
    status: 'permanent',
    platform: 'win32',
    note: 'Vendored Teensy core. Adds long long overloads so uintptr_t and '
        + 'size_t are not ambiguous on LLP64, where unsigned long is 32-bit.',
    edits: [
      /*
       * Windows is LLP64: `long` is 32 bits and pointers are 64. Linux is
       * LP64, where `long` is 64 bits.
       *
       * Print's integer overload set stops at `unsigned long`. On Linux that
       * happens to be an exact match for uintptr_t and size_t, so
       * `Serial.println(adr, HEX)` resolves cleanly. On Windows there is no
       * exact match and every candidate - int, unsigned int, long, unsigned
       * long, double - is an equally ranked conversion, so the call is
       * ambiguous. okcore.cpp and okcrypto.cpp hit this a dozen times, all in
       * DEBUG traces printing addresses and lengths.
       *
       * Adding exact matches for the 64-bit types fixes every such call site
       * at once, including ones not written yet, which casting at each site
       * would not.
       *
       * They delegate to the 32-bit path, so a value above 2^32 would be
       * truncated in debug output. That is acceptable and bounded here: every
       * current caller passes a flash address inside a 256 KB map or a key
       * length, and both are far below the limit. It is called out rather
       * than hidden because on Linux the same call prints the full 64 bits.
       *
       * PERMANENT. Print.h is vendored Teensy code and must not learn about
       * the emulator, so there is no OK_EMULATOR gate to promote this to.
       */
      ['\tsize_t print(unsigned long n, int base)\t\t{ return printNumber(n, base, 0); }',
       '\tsize_t print(unsigned long n, int base)\t\t{ return printNumber(n, base, 0); }\n'
       + '\n'
       + '\t/* LLP64 hosts: uintptr_t/size_t are long long, not long. Added by\n'
       + '\t * the emulator\'s stage patch - see emulator/scripts/stage.js. */\n'
       + '\tsize_t print(long long n)\t\t\t{ return print((long)n); }\n'
       + '\tsize_t print(unsigned long long n)\t\t{ return print((unsigned long)n); }\n'
       + '\tsize_t print(long long n, int base)\t\t{ return print((long)n, base); }\n'
       + '\tsize_t print(unsigned long long n, int base)\t{ return print((unsigned long)n, base); }'],

      ['\tsize_t println(unsigned long n, int base)\t{ return print(n, base) + println(); }',
       '\tsize_t println(unsigned long n, int base)\t{ return print(n, base) + println(); }\n'
       + '\n'
       + '\tsize_t println(long long n)\t\t\t{ return print(n) + println(); }\n'
       + '\tsize_t println(unsigned long long n)\t\t{ return print(n) + println(); }\n'
       + '\tsize_t println(long long n, int base)\t\t{ return print(n, base) + println(); }\n'
       + '\tsize_t println(unsigned long long n, int base)\t{ return print(n, base) + println(); }'],
    ],
  },

  {
    file: 'core/Print.cpp',
    status: 'permanent',
    note: 'Vendored Teensy core. Print::printf passes `(int)this` as a file '
        + 'descriptor, which truncates a 64-bit pointer. Redirected to '
        + 'okemu_vdprintf() with the pointer intact.',
    edits: [
      /*
       * Teensyduino writes Print::printf as
       *
       *     return vdprintf((int)this, format, ap);
       *
       * with a weak `_write(int file, ...)` just above it that casts the
       * "descriptor" back to a Print *. On the device that round-trips
       * through newlib's stdio and works, because sizeof(int) equals
       * sizeof(void *) there.
       *
       * On a 64-bit host it truncates the pointer. Linux then reaches glibc's
       * vdprintf, which knows nothing about _write and treats the truncated
       * value as a real descriptor - so the write fails with EBADF and every
       * Serial.printf() in the firmware disappears, silently. Windows has no
       * vdprintf in its CRT at all, which is how this surfaced.
       *
       * Unconditional, not Windows-gated: the truncation is wrong on every
       * 64-bit host, so this is a correction rather than a portability shim.
       * See core-override/okemu_printf.cpp.
       *
       * PERMANENT. Print.cpp is vendored Teensy code, not OnlyKey code, so it
       * must not learn about the emulator - there is no OK_EMULATOR gate to
       * promote this to.
       */
      ['return vdprintf((int)this, format, ap);',
       'return okemu_vdprintf((void *)this, format, ap);'],
      ['return vdprintf((int)this, (const char *)format, ap);',
       'return okemu_vdprintf((void *)this, (const char *)format, ap);'],
    ],
  },

  /* Windows only via its `platform` field: on Linux the flash maps at its
   * real base, and shifting the constants there would move the firmware off
   * its own storage. */
  WINDOWS_FLASH_PATCH,
];

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
  const provisional = [];

  for (const p of PATCHES) {
    /* Host-specific entries. No `platform` means every host. */
    if (p.platform && p.platform !== process.platform) continue;

    /*
     * An entry with no status predates the register, or was added without
     * one. Treat that as provisional rather than permanent: the failure mode
     * of reviewing a permanent patch again is a wasted minute, while the
     * failure mode of forgetting a provisional one is a firmware change that
     * never lands and a patch that quietly becomes load-bearing.
     */
    if ((p.status || 'provisional') === 'provisional') provisional.push(p);

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

  /*
   * Say out loud what is still sitting in the staging ground. A provisional
   * patch is unfinished work by definition, and the way it goes wrong is not
   * by breaking - it is by working, and being forgotten, until the patch list
   * is quietly carrying firmware behaviour nobody reviews.
   */
  if (provisional.length) {
    console.error('');
    console.error('stage: PROVISIONAL patches applied - not yet in firmware:');
    for (const p of provisional) {
      console.error(`  ${p.file}`);
      if (p.note) {
        for (const line of wrap(p.note, 68)) console.error(`      ${line}`);
      }
    }
    console.error('  Promote each to an #ifdef OK_EMULATOR gate in the source');
    console.error('  once it has been built and tested from here, then delete');
    console.error('  the entry. See the rule above PATCHES.');
  }

  return applied;
}

/* Wrap a note to a column so the reminder stays readable in a build log. */
function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = ''; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
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

  // 6. documented source-level fixups
  const patched = applyPatches();

  console.log(
    `stage: ${path.relative(ROOT, STAGE)}\n` +
    `  core files overlaid from OnlyKey-Firmware: ${overlaid}\n` +
    `  emulator overrides applied:                ${overrides}\n` +
    `  bare-metal files dropped:                  ${dropped}\n` +
    `  source patches applied:                    ${patched}`
  );
}

main();
