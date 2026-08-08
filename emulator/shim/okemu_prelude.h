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
#include <stdarg.h>
/*
 * <stdio.h> is here for mbedtls. platform.cpp includes only config.h and
 * platform.h, then calls _vsnprintf_s() inside `#if defined(_TRUNCATE)`. The
 * MSVC CRT defines _TRUNCATE in <stdlib.h>, so that branch is taken, but
 * declares _vsnprintf_s in <stdio.h>, which nothing there includes - so it
 * compiles everywhere else and fails only on Windows. Linux never takes the
 * branch, because glibc has no _TRUNCATE.
 */
#include <stdio.h>

/*
 * Print::printf's replacement. Declared here rather than in a header the core
 * includes, because the call sites are in the vendored Print.cpp and are
 * redirected by a staged patch - see scripts/stage.js and
 * core-override/okemu_printf.cpp for why the original cannot work on a 64-bit
 * host.
 *
 * void * rather than Print *: this header is force-included into C
 * translation units too, where Print does not exist.
 */
#ifdef __cplusplus
extern "C"
#endif
int okemu_vdprintf(void *print_obj, const char *format, va_list ap);

/*
 * TimeLib.h opens with
 *
 *     #if !defined(__time_t_defined)   // avoid conflict with newlib or other posix libc
 *     typedef unsigned long time_t;
 *     #endif
 *
 * and that guard is a glibc/newlib spelling. glibc defines it, so on Linux the
 * typedef is skipped and the emulator has always used the platform's time_t.
 * The MSVC CRT does not define it under any name TimeLib knows, so the typedef
 * fires and collides with <time.h>'s - C2371, redefinition with a different
 * basic type, on the first translation unit that pulls both in.
 *
 * Declaring it here makes Windows behave the way Linux already does. This is
 * not a behaviour change dressed up as a portability fix: on the device
 * `unsigned long` is 32 bits, but the hosted Linux build has been using
 * glibc's 64-bit time_t all along, so matching that is what keeps the two
 * hosted platforms identical to each other.
 *
 * It belongs here rather than in TimeLib.h because TimeLib is a stock Arduino
 * library under onlykey/, and the collision is an artifact of hosting rather
 * than something the firmware owns.
 */
#ifdef _WIN32
#define __time_t_defined 1
#endif

/*
 * Two more things glibc supplies that the MSVC CRT does not. Both are pure
 * hosting artifacts - the firmware is correct on its own toolchain, and
 * neither belongs in the OnlyKey sources.
 */
#ifdef _WIN32

/*
 * `uint`. A BSD spelling that glibc's <sys/types.h> exposes under __USE_MISC
 * and the MSVC CRT has never had. T3Mac.cpp uses it for a loop counter.
 */
typedef unsigned int uint;

/*
 * `ssize_t`. POSIX, from <unistd.h>, which the MSVC CRT does not have.
 * tinycbor's open_memstream.c guards its own include with
 * `#if defined(__unix__) || defined(__APPLE__)` and then uses the type
 * unconditionally, so on Windows nothing declares it.
 *
 * Signed 64-bit to match the pointer width, which is what SSIZE_T in
 * <BaseTsd.h> is - declared here rather than dragging in a Windows header.
 */
#ifndef _SSIZE_T_DEFINED
#define _SSIZE_T_DEFINED
typedef long long ssize_t;
#endif

/*
 * Shared firmware globals, declared once with C linkage and the type each one
 * is actually defined with.
 *
 * okcore.h wraps its declarations in `extern "C"`, so these symbols have C
 * linkage. Several .cpp files then re-declare them locally without the
 * linkage specification, and often with a different type than the definition:
 * outputmode and Profile_Offset are `int` in okcore.cpp and `uint8_t` in
 * their users, and keyboard_buffer is an array declared as a pointer.
 *
 * The Itanium C++ ABI does not mangle global variable names, so on Linux
 * every one of those spellings resolves to the same symbol and the type
 * confusion is invisible. The MSVC ABI does mangle them, so each variant
 * becomes a distinct symbol that nothing defines - seven undefined symbols at
 * link time.
 *
 * Declaring them here, force-included ahead of everything, gives all
 * translation units one consistent view; scripts/stage.js deletes the local
 * re-declarations so nothing contradicts it. It has to be a single namespace-
 * scope declaration rather than `extern "C"` added in place, because six of
 * the originals are at block scope and C++ permits a linkage-specification
 * only at namespace scope.
 *
 * The types here are the definitions' types, which means the translation
 * units that declared uint8_t now see int. That is a real change, and it is
 * the correct direction - reading one byte of an int was always wrong - but
 * it is a firmware behaviour change and should be treated as one. In practice
 * these hold small values on a little-endian host, so the low byte the old
 * declarations read is the same value.
 */
#ifdef __cplusplus
extern "C" {
#endif
extern int     large_buffer_offset;   /* okcore.cpp: int                  */
extern uint8_t keyboard_buffer[];     /* okcore.cpp: uint8_t[80]          */
extern uint8_t KeyboardLayout[];      /* keylayouts.c: uint8_t[1], C file */
extern uint8_t setBuffer[];           /* okcore.cpp: uint8_t[9]           */
extern uint8_t CRYPTO_AUTH;           /* okcore.cpp: uint8_t              */
extern int     outputmode;            /* okcore.cpp: int                  */
extern int     Profile_Offset;        /* okcore.cpp: int                  */
#ifdef __cplusplus
}
#endif

/*
 * `_Bool` in C++. glibc's <stdbool.h> carries a C++ branch that reads
 *
 *     #if defined __cplusplus
 *     // Supporting <stdbool.h> in C++ is a GCC extension.
 *     # define _Bool bool
 *
 * so a C header using _Bool keeps working when included from C++. MSVC's
 * <stdbool.h> has no such branch, and _Bool is a C keyword that does not
 * exist in C++ - so fido2/ctap.h fails on two struct members that are
 * perfectly legal everywhere else.
 *
 * Defining it exactly the way glibc does, rather than editing the header, is
 * the point: this is replicating a platform's behaviour, not changing the
 * firmware's.
 */
#ifdef __cplusplus
#include <stdbool.h>
#ifndef _Bool
#define _Bool bool
#endif
#endif

#endif /* _WIN32 */

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

#endif /* OKEMU_PRELUDE_H */
