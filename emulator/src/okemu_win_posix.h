/*
 * okemu_win_posix.h - the POSIX calls this emulator uses, on Win32.
 *
 * ok_hal.cpp and okemu_restart.cpp are written against POSIX because that is
 * what the emulator was born on. Rather than thread #ifdefs through their
 * logic, the handful of functions they actually call are provided here and
 * the sources read the same on both platforms.
 *
 * This is NOT a general mmap shim. It implements exactly the two mapping
 * shapes ok_hal.cpp asks for and nothing else:
 *
 *   1. anonymous, private, at a FIXED address   -> VirtualAlloc
 *      (the peripheral windows: 0x40000000, 0x42000000, 0xE0000000)
 *   2. file-backed, shared, address of OUR choosing -> CreateFileMapping
 *      (the flash and eeprom arrays)
 *
 * Anything else will assert rather than quietly do the wrong thing.
 *
 * ## Why the flash array cannot be mapped where Linux maps it
 *
 * On Linux the flash array is mapped at absolute address 0, so the firmware's
 * own constants (fwstartadr 0x6060, certified_hw 0x5BB0, storage 0x3A800) are
 * already correct as written. Windows reserves the bottom 64 KB of every
 * process's address space as the null-pointer guard and offers no way to
 * lower it - VirtualAlloc's lowest allocatable address IS 0x10000. Both of
 * ok_hal.cpp's fallback rungs are therefore unreachable here, and the higher
 * one is the rung its own comment says breaks every AES-GCM operation.
 *
 * So on Windows the array is mapped wherever Windows likes and the firmware
 * is told where that is - see OKEMU_FLASH_BASE in ok_hal.h and the okcore.h
 * rebase in scripts/stage.js. That is the same answer ok-rn/android/okemu
 * reached for Android, for the same reason.
 */
#ifndef OKEMU_WIN_POSIX_H
#define OKEMU_WIN_POSIX_H
#ifdef _WIN32

#include <windows.h>
#include <bcrypt.h>   /* okemu_random_bytes: the platform CSPRNG */
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <stdint.h>
#include <stdio.h>
#include <assert.h>

/* ---------------------------------------------------------------- mman -- */

#define PROT_READ   0x1
#define PROT_WRITE  0x2

#define MAP_SHARED            0x01
#define MAP_PRIVATE           0x02
#define MAP_ANONYMOUS         0x20
#define MAP_FIXED_NOREPLACE   0x100000

#define MAP_FAILED ((void *)-1)

/*
 * mmap(). `off` is honoured only for the file-backed shape.
 *
 * The fixed-address case uses VirtualAlloc, which already behaves like
 * MAP_FIXED_NOREPLACE rather than MAP_FIXED: it FAILS if the range is taken
 * instead of evicting whatever is there. That is the semantic ok_hal.cpp
 * relies on when it probes the peripheral windows, so the flag needs no
 * separate handling.
 */
static inline void *mmap(void *addr, size_t len, int prot, int flags,
                         int fd, long long off) {
  (void)prot;

  if (flags & MAP_ANONYMOUS) {
    /* Peripheral window: must land exactly where asked, or not at all. */
    void *p = VirtualAlloc(addr, len, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    return p ? p : MAP_FAILED;
  }

  /*
   * File-backed. addr is ignored deliberately: MapViewOfFileEx could honour
   * it, but every caller that reaches here on Windows is mapping relocatably
   * and reads back the address we return.
   */
  assert(fd >= 0 && "file-backed mmap needs a descriptor");
  HANDLE h = (HANDLE)_get_osfhandle(fd);
  if (h == INVALID_HANDLE_VALUE) return MAP_FAILED;

  HANDLE m = CreateFileMappingW(h, NULL, PAGE_READWRITE, 0, 0, NULL);
  if (!m) return MAP_FAILED;

  void *p = MapViewOfFile(m, FILE_MAP_READ | FILE_MAP_WRITE,
                          (DWORD)(off >> 32), (DWORD)(off & 0xFFFFFFFF), len);
  /*
   * The view holds its own reference to the section, so the handle is closed
   * immediately and munmap() needs no bookkeeping to undo this.
   */
  CloseHandle(m);
  return p ? p : MAP_FAILED;
}

/*
 * munmap() has to undo whichever of the two shapes it is handed, and Windows
 * uses a different call for each. VirtualQuery tells them apart without any
 * registry on our side: a file view reports MEM_MAPPED, VirtualAlloc'd pages
 * report MEM_PRIVATE.
 */
static inline int munmap(void *addr, size_t len) {
  MEMORY_BASIC_INFORMATION mbi;
  if (!VirtualQuery(addr, &mbi, sizeof mbi)) return -1;
  if (mbi.Type == MEM_MAPPED) return UnmapViewOfFile(addr) ? 0 : -1;
  (void)len;  /* MEM_RELEASE frees the whole original reservation */
  return VirtualFree(addr, 0, MEM_RELEASE) ? 0 : -1;
}

#define MS_SYNC 0x4
static inline int msync(void *addr, size_t len, int flags) {
  (void)flags;
  return FlushViewOfFile(addr, len) ? 0 : -1;
}

/* ------------------------------------------------------------- unistd -- */

/*
 * open() - and the one flag that matters.
 *
 * _O_BINARY is added unconditionally. Without it the CRT opens in TEXT mode
 * and silently translates \n to \r\n on write and back on read, which would
 * corrupt the flash and eeprom images - arbitrary binary where byte 0x0A is
 * ordinary data. POSIX has no such mode, so the callers do not know to ask.
 */
static inline int okemu_open(const char *path, int flags) {
  return _open(path, flags | _O_BINARY, _S_IREAD | _S_IWRITE);
}
static inline int okemu_open(const char *path, int flags, int mode) {
  return _open(path, flags | _O_BINARY, mode ? mode : (_S_IREAD | _S_IWRITE));
}
/* Variadic so both the 2-arg and 3-arg POSIX spellings work; the overloads
 * above pick the right one. <io.h> already declares a variadic `open` as a
 * deprecated alias, which is why this must be a macro rather than a plain
 * function - it has to win over that declaration at the call site. */
#define open(...) okemu_open(__VA_ARGS__)
#define close  _close
#define write  _write
#define read   _read

/* ftruncate(fd, len) -> _chsize_s, which also returns 0 on success. */
static inline int ftruncate(int fd, long long len) {
  return _chsize_s(fd, len) == 0 ? 0 : -1;
}

#include <direct.h>
/* mkdir(path, mode) - Windows has no mode argument; the run directory's
 * permissions come from the parent, which is what _mkdir gives us. */
static inline int okemu_mkdir(const char *path, int mode) {
  (void)mode;
  return _mkdir(path);
}
#define mkdir(p, m) okemu_mkdir((p), (m))

#define STDERR_FILENO 2

/*
 * pread/pwrite - positional I/O that does NOT move the descriptor's offset.
 *
 * Implemented with OVERLAPPED rather than lseek-then-read. The seek pair would
 * be simpler but is two operations on shared state: ok_hal.cpp reads and
 * writes flash from the firmware thread while the HAL's own callers touch the
 * same descriptor, and an interleaving there would read from the wrong
 * offset. OVERLAPPED carries the offset with the request, so it is atomic and
 * leaves the file pointer alone - exactly what the POSIX calls promise.
 */
static inline long long okemu_pio(int fd, void *buf, size_t n, long long off,
                                  int writing) {
  HANDLE h = (HANDLE)_get_osfhandle(fd);
  if (h == INVALID_HANDLE_VALUE) return -1;
  OVERLAPPED ov;
  ZeroMemory(&ov, sizeof ov);
  ov.Offset     = (DWORD)(off & 0xFFFFFFFF);
  ov.OffsetHigh = (DWORD)(off >> 32);
  DWORD done = 0;
  BOOL ok = writing ? WriteFile(h, buf, (DWORD)n, &done, &ov)
                    : ReadFile(h, buf, (DWORD)n, &done, &ov);
  return ok ? (long long)done : -1;
}
static inline long long pread(int fd, void *buf, size_t n, long long off) {
  return okemu_pio(fd, buf, n, off, 0);
}
static inline long long pwrite(int fd, const void *buf, size_t n,
                               long long off) {
  return okemu_pio(fd, (void *)buf, n, off, 1);
}

/* --------------------------------------------------------------- time -- */

/*
 * struct timespec comes from the UCRT's own <time.h> (C11), which is reachable
 * now that stage.js removes Arduino's Time.h from the include path. Only the
 * two FUNCTIONS are missing - clock_gettime and nanosleep are POSIX, and the
 * UCRT offers neither.
 */
#include <time.h>

#define CLOCK_MONOTONIC 1
static inline int clock_gettime(int clk, struct timespec *ts) {
  (void)clk;
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  ts->tv_sec  = c.QuadPart / f.QuadPart;
  ts->tv_nsec = (long)(((c.QuadPart % f.QuadPart) * 1000000000LL) / f.QuadPart);
  return 0;
}

static inline int nanosleep(const struct timespec *req,
                            struct timespec *rem) {
  (void)rem;
  /* Sleep() is millisecond-granular; never 0, which does not yield to a
   * lower-priority thread. Callers here are throttles, not timing sources. */
  DWORD ms = (DWORD)(req->tv_sec * 1000LL + req->tv_nsec / 1000000L);
  Sleep(ms ? ms : 1);
  return 0;
}

/* ----------------------------------------------------------- execinfo -- */

/*
 * backtrace() is a glibc extension. okemu_restart.cpp uses it only to print a
 * diagnostic when the firmware faults, so CaptureStackBackTrace covers it.
 * backtrace_symbols() would need DbgHelp and a symbol path; returning NULL is
 * honest and the caller already handles it by printing raw addresses.
 */
static inline int backtrace(void **buf, int size) {
  return (int)CaptureStackBackTrace(0, (DWORD)size, buf, NULL);
}
static inline char **backtrace_symbols(void *const *buf, int size) {
  (void)buf; (void)size;
  return NULL;
}

#endif /* _WIN32 */
#endif /* OKEMU_WIN_POSIX_H */
