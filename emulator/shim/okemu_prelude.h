/*
 * okemu_prelude.h - force-included (-include) into every translation unit.
 *
 * The Teensy core (WProgram.h) declares `uint32_t random(void)` / `void
 * srandom(uint32_t)`, which collide with glibc's `long int random(void)` /
 * `void srandom(unsigned)`. On the real toolchain (arm-none-eabi + -nostdlib)
 * glibc's declarations are never seen, so the conflict cannot arise.
 *
 * We pull in the system headers FIRST, then rename the Teensy spellings. Doing
 * it here - rather than in a shim Arduino.h - guarantees the ordering holds in
 * every TU, including ones that include <stdlib.h> only indirectly and later.
 *
 * Shadowing here rather than editing WProgram.h keeps a name collision that is
 * purely an artifact of hosting - the device links against no libc at all - out
 * of the firmware sources. Divergences the FIRMWARE genuinely owns are gated in
 * the OnlyKey sources under OK_EMULATOR instead; see README.
 */
#ifndef OKEMU_PRELUDE_H
#define OKEMU_PRELUDE_H

#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

/* Teensy's random()/srandom() -> distinct names, away from glibc's. */
#define random  teensy_random
#define srandom teensy_srandom

/*
 * kinetis.h defines these as raw Cortex-M inline asm:
 *     #define __disable_irq() __asm__ volatile("CPSID i":::"memory");
 * `cpsid`/`cpsie` are not x86 instructions, so any caller fails at assembly
 * time (the preprocessor and compiler are happy - only `as` objects).
 *
 * Interrupt masking has no meaning here: the firmware runs on one ordinary
 * thread and every peripheral it guards against is backed by memory rather
 * than by an ISR. The HAL's own shared state carries its own mutex.
 *
 * These are a FALLBACK for any translation unit that reaches __disable_irq()
 * without pulling in kinetis.h. They cannot override the header itself: it
 * #defines the same names unconditionally and later, and the last definition
 * wins. Rewriting kinetis.h's own spelling is the only lever, which is why the
 * staged patch in scripts/stage.js exists and is the one that actually works.
 *
 * The compiler barrier is kept in both, since the firmware brackets flash and
 * USB buffer updates with these and relies on them not being reordered.
 */
#define __disable_irq() __asm__ volatile("" ::: "memory")
#define __enable_irq()  __asm__ volatile("" ::: "memory")

/*
 * vdprintf() for Windows - Print::printf()'s only dependency.
 *
 * Teensy's core/Print.cpp does:
 *
 *     int Print::printf(const char *format, ...) {
 *         return vdprintf((int)this, format, ap);
 *
 * vdprintf(3) is POSIX and the UCRT has no equivalent. Note what is being
 * passed as the file descriptor: `this`, a pointer, truncated to int. That is
 * not a descriptor on any platform - on glibc it is simply some arbitrary
 * number that write(2) rejects, so these calls have always failed silently
 * rather than printed anything. The firmware does not use Print::printf; the
 * method exists because it is part of the stock core.
 *
 * So the shim's job is to let the core COMPILE, not to make a broken call
 * work. Sending the text to stderr is the one interpretation that is useful on
 * a host if anything ever does reach it, and the bogus descriptor is ignored
 * rather than dignified.
 */
#ifdef _WIN32
#include <stdio.h>
#include <stdarg.h>
static inline int okemu_vdprintf(int /*fd - see above*/, const char *fmt,
                                 va_list ap) {
  return vfprintf(stderr, fmt, ap);
}
#define vdprintf okemu_vdprintf

/*
 * `uint` - a BSD spelling glibc exposes from <sys/types.h> and the UCRT does
 * not. libraries/T3Mac/T3Mac.cpp:34 declares a local with it. It is always
 * exactly unsigned int where it exists, so the typedef is not a guess.
 */
typedef unsigned int uint;

/*
 * Where the emulated flash array lives, on Windows.
 *
 * OKEMU_FLASH_BASE is the NAME OF THIS VARIABLE, not an address - Windows
 * chooses where the 256 KB lands and okemu_hal_init() records it. stage.js
 * rewrites okcore.h's four address literals as OKEMU_FLASH_BASE + offset, and
 * okcore.h includes nothing of ours, so the declaration has to arrive through
 * this prelude, which is force-included into every translation unit.
 *
 * ok_hal.h spells the same macro identically, which the standard permits: a
 * macro may be redefined with the same token sequence. Both are kept, so
 * neither file depends on the other having been included first.
 */
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
extern uintptr_t okemu_flash_base;
#ifdef __cplusplus
}
#endif
#define OKEMU_FLASH_BASE okemu_flash_base

/*
 * `ssize_t` - POSIX, and the UCRT has no such name.
 *
 * libraries/tinycbor/open_memstream.c:42 uses it. That file is tinycbor's own
 * replacement for open_memstream(3), which Windows also lacks, so the shim
 * needs a shim. Windows spells the same type SSIZE_T in <BaseTsd.h>; it is
 * `__int64` on x64, so long long is the same width and signedness.
 *
 * Guarded so it stands down if a Windows header gets there first - several
 * define it and set _SSIZE_T_DEFINED when they do.
 */
#if !defined(_SSIZE_T_DEFINED) && !defined(ssize_t)
typedef long long ssize_t;
#define _SSIZE_T_DEFINED
#endif
#endif

/*
 * `_Bool` INSIDE C++ - a GCC extension, not a Windows gap.
 *
 * libraries/fido2/ctap.h:376-377 and ctap_parse.cpp:503 declare _Bool fields
 * in headers included from C++ translation units. _Bool is a C99 keyword; in
 * C++ the type is `bool` and the underscore spelling does not exist. GCC
 * accepts it in C++ anyway as an extension, which is why the firmware and the
 * Linux emulator build, and clang rejects it.
 *
 * Guarded on the COMPILER rather than the platform, because that is what the
 * difference actually is - a clang build on Linux would need this too. The two
 * types are layout-compatible, so this changes no ABI.
 */
#if defined(__clang__) && defined(__cplusplus)
#define _Bool bool
#endif

#endif /* OKEMU_PRELUDE_H */
