/*
 * okemu_printf.cpp - a working Print::printf for a 64-bit host.
 *
 * Teensyduino implements Print::printf as
 *
 *     return vdprintf((int)this, format, ap);
 *
 * and provides, immediately above it, a weak
 *
 *     extern "C" int _write(int file, char *ptr, int len)
 *     { ((class Print *)file)->write((uint8_t *)ptr, len); return 0; }
 *
 * On the device that works: newlib's vdprintf formats and hands the result to
 * the _write syscall stub, so the "fd" is never treated as a real descriptor -
 * it is a Print pointer making a round trip through newlib's stdio, and the
 * weak _write catches it on the way out. Hacky, but sound on a 32-bit target
 * where sizeof(int) == sizeof(void *).
 *
 * Hosted on a 64-bit machine it is not sound, and the failure is silent.
 * `(int)this` truncates a 64-bit pointer to 32 bits. On Linux the call then
 * reaches glibc's vdprintf, which really does write to a file descriptor and
 * knows nothing about _write, so the truncated pointer is used as an fd: the
 * write fails with EBADF and every Serial.printf() in the firmware vanishes.
 * That has presumably always been the case here - okcrypto.cpp's RSA and
 * shared-secret traces are all Serial.printf - and nothing reports it because
 * a failed write returns quietly.
 *
 * On Windows it does not even compile: the MSVC CRT has no vdprintf at all,
 * which is how this was found.
 *
 * So the fix is not a portability shim, it is a correction, and it applies
 * everywhere. scripts/stage.js rewrites both call sites in the staged Print.cpp
 * to call okemu_vdprintf() with the pointer intact, and this provides it.
 * Nothing under onlykey/ is modified; the vendored core keeps no emulator
 * knowledge of its own.
 *
 * Output goes through Print::write, which is the same path every other
 * Serial.print() takes - so printf output lands on SEREMU exactly like the
 * rest of the debug console rather than on a descriptor.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdint.h>
#include <stddef.h>

#include "Print.h"

/*
 * One line of debug output. The firmware's own SEREMU path chunks at 64 bytes
 * anyway, so a longer format is truncated rather than heap-allocated - this is
 * a debug channel on an emulated MCU, and a printf that quietly allocates is a
 * worse failure than one that clips.
 */
#define OKEMU_PRINTF_MAX 512

extern "C" int okemu_vdprintf(void *print_obj, const char *format, va_list ap)
{
    char buf[OKEMU_PRINTF_MAX];
    int n;

    if (print_obj == NULL || format == NULL) return -1;

    n = vsnprintf(buf, sizeof(buf), format, ap);
    if (n <= 0) return n;

    /* vsnprintf returns what it WOULD have written; clamp to what it did. */
    size_t len = (size_t)n;
    if (len >= sizeof(buf)) len = sizeof(buf) - 1;

    ((Print *)print_obj)->write((const uint8_t *)buf, len);

    /* Match printf's contract: the untruncated length. */
    return n;
}
