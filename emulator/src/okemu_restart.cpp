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
#include <signal.h>
#ifdef _WIN32
#include "okemu_win_posix.h"   /* backtrace, mmap, ... */
#else
#include <execinfo.h>
#include <sys/mman.h>
#include <unistd.h>
#endif
#include <stdlib.h>
#include <time.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>

#include "ok_hal.h"

/* Provided by the firmware: OnlyKey.ino's setup() and SoftTimer's loop(). */
extern "C" void setup(void);
extern "C" void loop(void);

namespace {

const uintptr_t kAIRCR     = 0xE000ED0CUL;
const size_t    kPageSize  = 4096;
const uintptr_t kSCBPage   = kAIRCR & ~(uintptr_t)(kPageSize - 1);

okemu_event_sink g_restart_fn  = nullptr;
void            *g_restart_ctx = nullptr;

#ifdef _WIN32

volatile long g_armed = 0;

/*
 * The same three-way decision as the POSIX handler below, expressed as a
 * Structured Exception filter.
 *
 * Windows has no equivalent of longjmp-ing out of a fault handler - on x64
 * the unwinder owns that path and siglongjmp's trick is not available. SEH
 * makes the park unnecessary instead: returning EXCEPTION_EXECUTE_HANDLER
 * transfers to the __except block in okemu_firmware_run(), which is exactly
 * where sigsetjmp() was waiting. The other two verdicts have direct
 * equivalents: CONTINUE_EXECUTION retries the faulting store after we widen
 * the protection, and CONTINUE_SEARCH lets a genuine crash reach the
 * debugger and the default handler, as the POSIX path does by restoring
 * g_prev_segv.
 */
int restart_filter(EXCEPTION_POINTERS *ep) {
  const EXCEPTION_RECORD *er = ep->ExceptionRecord;
  if (er->ExceptionCode != EXCEPTION_ACCESS_VIOLATION)
    return EXCEPTION_CONTINUE_SEARCH;

  /* [0] is read/write/execute, [1] is the address touched. */
  const uintptr_t at = (uintptr_t)er->ExceptionInformation[1];

  if (g_armed && at >= kAIRCR && at < kAIRCR + 4) {
    if (getenv("OKEMU_TRACE_RESTART")) {
      fprintf(stderr, "\n[okemu] CPU_RESTART() from:\n");
      void *frames[24];
      int depth = backtrace(frames, 24);
      /* No backtrace_symbols_fd here: resolving names would mean DbgHelp and
       * a symbol path. Raw addresses still identify the site against a map. */
      for (int i = 0; i < depth; i++) fprintf(stderr, "  %p\n", frames[i]);
      fflush(stderr);
    }
    okemu_request_restart();
    return EXCEPTION_EXECUTE_HANDLER;
  }

  if (at >= kSCBPage && at < kSCBPage + kPageSize) {
    /* Some other Cortex-M system register. Let the write through. */
    DWORD old;
    VirtualProtect((void *)kSCBPage, kPageSize, PAGE_READWRITE, &old);
    return EXCEPTION_CONTINUE_EXECUTION;
  }

  fprintf(stderr, "\n[okemu] FATAL: access violation at %p\n", (void *)at);
  {
    void *frames[32];
    int depth = backtrace(frames, 32);
    for (int i = 0; i < depth; i++) fprintf(stderr, "  %p\n", frames[i]);
  }
  fflush(stderr);
  return EXCEPTION_CONTINUE_SEARCH;
}

/*
 * A last-resort reporter for faults the __except below never sees.
 *
 * The SEH frame in okemu_firmware_run() only covers the firmware thread. A
 * fault on the systick thread, or inside an N-API callback, unwinds past it
 * and the process simply disappears - the test kit sees "the device host
 * exited (code 3221225477)" and nothing else, which is 0xC0000005 and says
 * only that SOMETHING dereferenced something.
 *
 * A vectored handler runs before any frame-based handler, on every thread, so
 * it can name the address whatever faulted. It never HANDLES anything:
 * returning EXCEPTION_CONTINUE_SEARCH leaves the __except below - and the
 * default handler after it - to decide, so arming this changes no behaviour.
 *
 * Writes inside the guarded SCB page are skipped, because those are the
 * CPU_RESTART trap doing its job and are not a crash.
 */
LONG CALLBACK fault_reporter(EXCEPTION_POINTERS *ep) {
  const EXCEPTION_RECORD *er = ep->ExceptionRecord;
  const DWORD code = er->ExceptionCode;

  /*
   * STACK_OVERFLOW is reported as well as ACCESS_VIOLATION, and the pair is
   * the point rather than thoroughness.
   *
   * A thread that has run out of stack cannot run a handler either - which is
   * why this saw nothing at all while a process still exited 0xC0000005. The
   * fix is SetThreadStackGuarantee in addon.cpp: it reserves a slice of stack
   * that only the exception machinery may use, so there is room to report the
   * overflow that just happened. Without that, "no handler fired" and
   * "something dereferenced a bad pointer" look identical from outside, and
   * they are not remotely the same bug.
   */
  if (code != EXCEPTION_ACCESS_VIOLATION && code != EXCEPTION_STACK_OVERFLOW)
    return EXCEPTION_CONTINUE_SEARCH;

  const uintptr_t at = (uintptr_t)er->ExceptionInformation[1];
  if (code == EXCEPTION_ACCESS_VIOLATION
      && at >= kSCBPage && at < kSCBPage + kPageSize)
    return EXCEPTION_CONTINUE_SEARCH;   /* the restart trap, not a fault */

  char line[256];
  int n = code == EXCEPTION_STACK_OVERFLOW
      ? snprintf(line, sizeof line,
                 "[okemu] STACK OVERFLOW (pc %p, thread %lu)\n",
                 er->ExceptionAddress, (unsigned long)GetCurrentThreadId())
      : snprintf(line, sizeof line,
                 "[okemu] ACCESS VIOLATION %s %p (pc %p, thread %lu)\n",
                 er->ExceptionInformation[0] ? "writing" : "reading",
                 (void *)at, er->ExceptionAddress,
                 (unsigned long)GetCurrentThreadId());
  if (n > 0) {
    fwrite(line, 1, (size_t)n, stderr);
    fflush(stderr);
    /*
     * And to a file, if one was named. A crashing child's stderr is not
     * reliably drained by whoever spawned it - the test kit reports only
     * "the device host exited (code 3221225477)" and the pipe contents die
     * with the process, which is exactly when this line is worth most.
     */
    const char *path = getenv("OKEMU_FAULT_LOG");
    if (path) {
      FILE *f = fopen(path, "a");
      if (f) { fwrite(line, 1, (size_t)n, f); fclose(f); }
    }
  }
  return EXCEPTION_CONTINUE_SEARCH;
}

/*
 * Armed at LOAD, not when the firmware starts.
 *
 * It was first registered inside arm_restart_trap(), which runs at the top of
 * okemu_firmware_run() - and that turned out to be too late to see the fault
 * being chased: the device host was dying between okemu_hal_init() and the
 * first line of the firmware, so the handler had never been installed and the
 * report never appeared. A constructor covers the module from the moment it is
 * loaded, which is the whole point of a reporter that never handles anything.
 */
__attribute__((constructor(102)))
void okemu_arm_fault_reporter(void) {
  AddVectoredExceptionHandler(1 /* call first */, fault_reporter);
  /* Records that the reporter is in place, so an empty log can be told apart
   * from a log that was never armed. */
  const char *path = getenv("OKEMU_FAULT_LOG");
  if (path) {
    FILE *f = fopen(path, "a");
    if (f) { fprintf(f, "[okemu] fault reporter armed (pid %lu)\n",
                     (unsigned long)GetCurrentProcessId()); fclose(f); }
  }
}

void arm_restart_trap() {
  DWORD old;
  VirtualProtect((void *)kSCBPage, kPageSize, PAGE_READONLY, &old);
  g_armed = 1;
}

void disarm_restart_trap() {
  DWORD old;
  g_armed = 0;
  VirtualProtect((void *)kSCBPage, kPageSize, PAGE_READWRITE, &old);
}

#else

sigjmp_buf         g_park;
volatile sig_atomic_t g_armed = 0;
struct sigaction   g_prev_segv;

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

#endif /* _WIN32 */

}  // namespace

extern "C" {

void okemu_set_restart_sink(okemu_event_sink fn, void *ctx) {
  g_restart_fn = fn;
  g_restart_ctx = ctx;
}

#ifdef _WIN32

/*
 * The firmware body, separated out so okemu_firmware_run() can wrap it in
 * __try/__except. clang-cl refuses SEH in a function that also needs C++
 * object unwinding, and keeping the two apart makes that impossible to
 * violate by accident later.
 */
static void firmware_body(void) {
  setup();
  for (;;) {
    loop();
    okemu_sync_systick();
  }
}

void okemu_firmware_run(void) {
  arm_restart_trap();

  __try {
    firmware_body();
  } __except (restart_filter(GetExceptionInformation())) {
    /* Arrived from the AIRCR trap: the firmware asked to reboot. */
    disarm_restart_trap();
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

#endif /* _WIN32 */

}  // extern "C"
