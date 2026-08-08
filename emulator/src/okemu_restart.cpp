/*
 * okemu_restart.cpp - turning CPU_RESTART() into a JavaScript event.
 *
 * okcore.h defines:
 *     #define CPU_RESTART_ADDR (uint32_t *)0xE000ED0C
 *     #define CPU_RESTART()    (*CPU_RESTART_ADDR = CPU_RESTART_VAL)
 *
 * i.e. a write to the Cortex-M Application Interrupt and Reset Control
 * Register. On hardware the core resets immediately and nothing after the
 * write executes. Against the HAL's plain mapped memory the store would simply
 * succeed and the firmware would carry on running in a state it believes is
 * unreachable - it uses CPU_RESTART() for lock timeouts, integrity failures
 * and post-wipe reinitialisation, so continuing is never correct.
 *
 * So the page holding AIRCR is mapped read-only and the store faults. The
 * handler recognises the address, parks the firmware thread via siglongjmp,
 * and the restart sink notifies JS. The process itself is left alone: the JS
 * side decides whether to respawn (and flash.bin / eeprom.bin persist across
 * that, so a reboot preserves device state exactly as it would on hardware).
 *
 * Faults elsewhere on the page are not restart requests. Rather than guess, we
 * unprotect the page and let the store retry so the firmware keeps running.
 */
#ifdef _WIN32
/*
 * The Windows form of the same trap.
 *
 * Structured exception handling replaces the signal handler, and the mapping
 * is closer than it looks: __except's filter is the handler, and its three
 * return values cover exactly the three cases the POSIX version distinguishes
 * with siglongjmp / return / chain-to-previous.
 *
 *   siglongjmp(g_park, 1)     EXCEPTION_EXECUTE_HANDLER    - the reboot path
 *   mprotect + return         EXCEPTION_CONTINUE_EXECUTION - retry the store
 *   restore default handler   EXCEPTION_CONTINUE_SEARCH    - a real crash
 *
 * Using __except rather than a vectored handler plus longjmp matters: the
 * firmware thread is deep inside C++ frames when CPU_RESTART() fires, and
 * longjmp out of an exception context on Windows x64 is not something to
 * rely on. Unwinding to the __except block is the supported route.
 */
#  define WIN32_LEAN_AND_MEAN
#  define NOMINMAX
#  include <windows.h>
#  include <dbghelp.h>
#  include <io.h>
#  include <stdlib.h>
#  include <stdio.h>
#  include <string.h>
#  pragma comment(lib, "dbghelp.lib")
#else
#include <signal.h>
#include <execinfo.h>
#include <stdlib.h>
#include <time.h>
#include <setjmp.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#endif

#include "ok_hal.h"

/* Provided by the firmware: OnlyKey.ino's setup() and SoftTimer's loop(). */
extern "C" void setup(void);
extern "C" void loop(void);

namespace {

const uintptr_t kAIRCR     = 0xE000ED0CUL;
const size_t    kPageSize  = 4096;
const uintptr_t kSCBPage   = kAIRCR & ~(uintptr_t)(kPageSize - 1);

#ifdef _WIN32
volatile long g_armed = 0;
#else
sigjmp_buf         g_park;
volatile sig_atomic_t g_armed = 0;
struct sigaction   g_prev_segv;
#endif

okemu_event_sink g_restart_fn  = nullptr;
void            *g_restart_ctx = nullptr;

#ifdef _WIN32

/* Write straight to fd 2 - the same discipline as the POSIX handler, which
 * avoids stdio locks while the thread is inside a fault. */
void err_write(const char *s, size_t n) { _write(2, s, (unsigned)n); }

/*
 * Symbolised stack trace. Same purpose as backtrace_symbols_fd: ten
 * CPU_RESTART() sites look identical from outside, and naming the one that
 * fired is the difference between "it rebooted" and "it rebooted HERE".
 *
 * SymInitialize is done once and left; this only ever runs on a reboot or a
 * crash, so the cost does not matter and tearing it down risks doing so while
 * another thread is mid-trace.
 */
void print_backtrace(int frames_wanted) {
  static bool sym_ready = false;
  if (!sym_ready) {
    SymSetOptions(SYMOPT_DEFERRED_LOADS | SYMOPT_UNDNAME | SYMOPT_LOAD_LINES);
    sym_ready = (SymInitialize(GetCurrentProcess(), NULL, TRUE) != FALSE);
  }

  void *frames[32];
  if (frames_wanted > 32) frames_wanted = 32;
  USHORT depth = CaptureStackBackTrace(1, (ULONG)frames_wanted, frames, NULL);

  char line[512];
  /* SYMBOL_INFO is variable-length: the name is appended past the struct. */
  unsigned char sym_buf[sizeof(SYMBOL_INFO) + 256] = { 0 };
  SYMBOL_INFO *sym = (SYMBOL_INFO *)sym_buf;
  sym->SizeOfStruct = sizeof(SYMBOL_INFO);
  sym->MaxNameLen   = 255;

  for (USHORT i = 0; i < depth; i++) {
    DWORD64 addr = (DWORD64)(uintptr_t)frames[i];
    int n;
    if (sym_ready && SymFromAddr(GetCurrentProcess(), addr, NULL, sym)) {
      DWORD disp = 0;
      IMAGEHLP_LINE64 ln = { sizeof(IMAGEHLP_LINE64) };
      if (SymGetLineFromAddr64(GetCurrentProcess(), addr, &disp, &ln)) {
        n = snprintf(line, sizeof line, "  %s (%s:%lu)\n",
                     sym->Name, ln.FileName, ln.LineNumber);
      } else {
        n = snprintf(line, sizeof line, "  %s\n", sym->Name);
      }
    } else {
      n = snprintf(line, sizeof line, "  %p\n", frames[i]);
    }
    if (n > 0) err_write(line, (size_t)n);
  }
}

/*
 * The filter. Runs before any unwinding, so it can still inspect and correct
 * the faulting state and resume - which is what the "some other system
 * register" case needs.
 */
LONG restart_filter(EXCEPTION_POINTERS *ep) {
  const EXCEPTION_RECORD *er = ep->ExceptionRecord;

  if (er->ExceptionCode != EXCEPTION_ACCESS_VIOLATION) {
    return EXCEPTION_CONTINUE_SEARCH;
  }

  /* ExceptionInformation[0] is 0 read / 1 write, [1] is the address. */
  const uintptr_t at = (uintptr_t)er->ExceptionInformation[1];

  if (g_armed && at >= kAIRCR && at < kAIRCR + 4) {
    if (getenv("OKEMU_TRACE_RESTART")) {
      static const char msg[] = "\n[okemu] CPU_RESTART() from:\n";
      err_write(msg, sizeof msg - 1);
      print_backtrace(24);
    }
    okemu_request_restart();
    return EXCEPTION_EXECUTE_HANDLER;      /* unwind to the __except block */
  }

  if (at >= kSCBPage && at < kSCBPage + kPageSize) {
    /* Some other Cortex-M system register. Let the write through and retry
     * the faulting instruction. */
    DWORD old = 0;
    VirtualProtect((LPVOID)kSCBPage, kPageSize, PAGE_READWRITE, &old);
    return EXCEPTION_CONTINUE_EXECUTION;
  }

  {
    static const char msg[] = "\n[okemu] FATAL: access violation at ";
    err_write(msg, sizeof msg - 1);
    char addr[32];
    int n = snprintf(addr, sizeof addr, "%p\n", (void *)at);
    if (n > 0) err_write(addr, (size_t)n);
    print_backtrace(32);
  }

  /* Not ours. Let Windows take it - which means WER, or a debugger. */
  return EXCEPTION_CONTINUE_SEARCH;
}

void arm_restart_trap() {
  DWORD old = 0;
  VirtualProtect((LPVOID)kSCBPage, kPageSize, PAGE_READONLY, &old);
  g_armed = 1;
}

#else

void segv_handler(int sig, siginfo_t *info, void *uctx) {
  const uintptr_t at = (uintptr_t)info->si_addr;

  if (g_armed && at >= kAIRCR && at < kAIRCR + 4) {
    /*
     * The firmware has ~10 CPU_RESTART() sites (integrity check, PIN flows,
     * wipes, bootloader entry) and they all look identical from outside: the
     * process just exits and pm2 respawns it. Reporting the call stack turns
     * "it rebooted" into "it rebooted HERE", which is the only practical way
     * to tell an expected reboot from a spurious one.
     *
     * Off by default - a reboot is normal operation. Set OKEMU_TRACE_RESTART=1.
     */
    if (getenv("OKEMU_TRACE_RESTART")) {
      static const char msg[] = "\n[okemu] CPU_RESTART() from:\n";
      write(STDERR_FILENO, msg, sizeof msg - 1);
      void *frames[24];
      int depth = backtrace(frames, 24);
      backtrace_symbols_fd(frames, depth, STDERR_FILENO);
    }
    okemu_request_restart();
    siglongjmp(g_park, 1);            /* never returns */
  }

  if (at >= kSCBPage && at < kSCBPage + kPageSize) {
    /* Some other Cortex-M system register. Let the write through. */
    mprotect((void *)kSCBPage, kPageSize, PROT_READ | PROT_WRITE);
    return;
  }

  /*
   * A genuine crash. Print a backtrace before letting the default handler
   * take it: the firmware runs on its own thread inside a Node addon, so a
   * fault here shows up only as pm2 silently respawning the daemon, with
   * nothing in either log to say why. ptrace_scope commonly blocks attaching
   * gdb after the fact, so self-reporting is the reliable option.
   */
  {
    static const char msg[] = "\n[okemu] FATAL: segfault at ";
    write(STDERR_FILENO, msg, sizeof msg - 1);
    char addr[32];
    int n = snprintf(addr, sizeof addr, "%p\n", info->si_addr);
    write(STDERR_FILENO, addr, n > 0 ? (size_t)n : 0);

    void *frames[32];
    int depth = backtrace(frames, 32);
    backtrace_symbols_fd(frames, depth, STDERR_FILENO);
  }

  sigaction(SIGSEGV, &g_prev_segv, nullptr);
  (void)sig; (void)uctx;
}

void arm_restart_trap() {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = segv_handler;
  sa.sa_flags = SA_SIGINFO | SA_NODEFER;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGSEGV, &sa, &g_prev_segv);

  mprotect((void *)kSCBPage, kPageSize, PROT_READ);
  g_armed = 1;
}

#endif  /* _WIN32 */

}  // namespace

extern "C" {

void okemu_set_restart_sink(okemu_event_sink fn, void *ctx) {
  g_restart_fn = fn;
  g_restart_ctx = ctx;
}

#ifdef _WIN32

/*
 * Split out so okemu_firmware_run() can use __try/__except. A function
 * containing SEH may not also need C++ unwinding, and the loop below has no
 * objects with destructors - keeping it in its own function makes that
 * property local and obvious rather than something to preserve by accident.
 */
static void firmware_loop(void) {
  setup();
  for (;;) {
    loop();
    okemu_sync_systick();
  }
}

void okemu_firmware_run(void) {
  arm_restart_trap();

  __try {
    firmware_loop();
  }
  __except (restart_filter(GetExceptionInformation())) {
    /* Arrived here from the AIRCR trap: the firmware asked to reboot. */
    DWORD old = 0;
    g_armed = 0;
    VirtualProtect((LPVOID)kSCBPage, kPageSize, PAGE_READWRITE, &old);
    okemu_hal_shutdown();
    if (g_restart_fn) g_restart_fn(g_restart_ctx);
  }
}

#else

void okemu_firmware_run(void) {
  if (sigsetjmp(g_park, 1) != 0) {
    /* Arrived here from the AIRCR trap: the firmware asked to reboot. */
    g_armed = 0;
    mprotect((void *)kSCBPage, kPageSize, PROT_READ | PROT_WRITE);
    okemu_hal_shutdown();
    if (g_restart_fn) g_restart_fn(g_restart_ctx);
    return;
  }

  arm_restart_trap();

  setup();
  for (;;) {
    loop();
    okemu_sync_systick();

    /*
     * Unreachable in practice: SoftTimerClass::run() is an infinite scheduler
     * loop, so loop() never returns. Kept because the contract of loop() does
     * not promise that, and a future SoftTimer could return between passes.
     * The CPU yield that actually matters lives in micros() - see
     * core-override/okemu_pins.cpp.
     */
  }
}

#endif  /* _WIN32 */

}  // extern "C"
