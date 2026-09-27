/*
 * ok_hal.cpp - see ok_hal.h for the design rationale.
 */
#include "ok_hal.h"

#ifdef _WIN32
#include "okemu_win_posix.h"   /* mmap, open, ftruncate, nanosleep, ... */
#include <sys/stat.h>
#else
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#endif
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <condition_variable>
#include <deque>
#include <string>
#include <vector>

#ifdef _WIN32
/*
 * Where the flash array landed. Declared in ok_hal.h, which every
 * firmware translation unit reaches, because okcore.h's rebased address
 * constants name it and okcore.h includes nothing of ours.
 */
extern "C" uintptr_t okemu_flash_base = 0;
#endif

namespace {

/*
 * Registers the firmware reads for identity/state. Named by their real
 * addresses so they can be checked against kinetis.h, and reached through the
 * relocated block (okemu_regs.cpp) - the same place the rewritten kinetis.h
 * sends the firmware.
 */
volatile uint32_t *reg32(uintptr_t a) { return (volatile uint32_t *)OKEMU_PBRIDGE(a); }
volatile uint8_t  *reg8 (uintptr_t a) { return (volatile uint8_t  *)OKEMU_PBRIDGE(a); }

const uintptr_t kSIM_SDID  = 0x40048024UL;
const uintptr_t kSIM_UIDH  = 0x40048054UL;
const uintptr_t kSIM_UIDMH = 0x40048058UL;
const uintptr_t kSIM_UIDML = 0x4004805CUL;
const uintptr_t kSIM_UIDL  = 0x40048060UL;
const uintptr_t kFTFL_FSTAT = 0x40020000UL;
const uintptr_t kFTFL_FSEC  = 0x40020002UL;  /* per kinetis.h:2350 */

/* ------------------------------------------------------------- state */

struct Hal {
  std::mutex mu;

  /* storage */
  std::string dir;
  uint8_t *flash = nullptr;     /* mapped at OKEMU_FLASH_BASE */
  int flash_fd = -1;
  size_t flash_mapped_off = 0;  /* first byte actually mapped (see init) */
  uint8_t eeprom[OKEMU_EEPROM_SIZE];
  int eeprom_fd = -1;

  /* time */
  uint64_t t0_us = 0;

  /* buttons */
  bool button[OKEMU_NUM_BUTTONS + 1] = { false };
  /* Samples still owed on a counted hold; 0 means "not counting". */
  int  ticks[OKEMU_NUM_BUTTONS + 1] = { 0 };
  /* Sense rounds completed since boot. Monotonic; never reset. */
  uint64_t rounds = 0;

  /* led */
  okemu_rgb px[OKEMU_NUM_PIXELS] = {};

  /* host -> device HID; each entry carries the interface it arrived on */
  struct InPkt { int iface; std::vector<uint8_t> data; };
  std::deque<InPkt> hid_in;
  std::condition_variable hid_cv;

  /* restart latch */
  bool restart = false;

  /* host -> device SEREMU (debug console input) */
  std::deque<uint8_t> seremu_in;

  /* sinks */
  okemu_stream_sink stream_sink = nullptr;  void *stream_ctx = nullptr;
  okemu_led_sink    led_sink    = nullptr;  void *led_ctx    = nullptr;
};

Hal g;

uint64_t now_us() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000ULL;
}

/* Open `name` under the storage dir at `size` bytes, creating it filled with
 * `fill` if absent. Returns an fd or -1. */
int open_backing(const std::string &dir, const char *name, size_t size,
                 uint8_t fill, char *err, size_t errlen) {
  std::string path = dir + "/" + name;
  int fd = ::open(path.c_str(), O_RDWR | O_CREAT, 0600);
  if (fd < 0) {
    snprintf(err, errlen, "cannot open %s: %s", path.c_str(), strerror(errno));
    return -1;
  }
  struct stat st;
  if (fstat(fd, &st) == 0 && (size_t)st.st_size != size) {
    if (ftruncate(fd, 0) != 0 || ftruncate(fd, (off_t)size) != 0) {
      snprintf(err, errlen, "cannot size %s: %s", path.c_str(), strerror(errno));
      ::close(fd);
      return -1;
    }
    /* A blank NOR flash / EEPROM array reads as 0xFF. */
    std::vector<uint8_t> blank(65536, fill);
    size_t left = size;
    while (left) {
      size_t n = left < blank.size() ? left : blank.size();
      if (write(fd, blank.data(), n) != (ssize_t)n) {
        snprintf(err, errlen, "cannot init %s: %s", path.c_str(), strerror(errno));
        ::close(fd);
        return -1;
      }
      left -= n;
    }
  }
  return fd;
}

/*
 * The registers must be SEEDED before ANY static initializer in the firmware
 * runs, not when okemu_hal_init() is called.
 *
 * T3Mac.cpp has a file-scope initializer that dereferences registers directly:
 *     unsigned long chipNum[4] = { SIM_UIDH, SIM_UIDMH, SIM_UIDML, SIM_UIDL };
 * That runs during dlopen(), long before JS can call start(). The blocks
 * themselves are static arrays (okemu_regs.cpp), so they exist from the moment
 * the module is loaded and nothing here can fail - this only puts the values
 * in them that the chip would hold at reset.
 *
 * A constructor priority below the default (65535) orders this ahead of every
 * C++ global constructor in the module. Priorities 0-100 are reserved for the
 * implementation, so 101 is the earliest slot available to us.
 *
 * The flash mapping is file-backed and needs the storage directory, so it
 * stays in okemu_hal_init(); nothing reads flash until setup() runs.
 */
__attribute__((constructor(101)))
void okemu_map_peripherals(void) {
  /*
   * Identity registers must hold their values before chipNum's initializer
   * samples them. SIM_SDID's PINID nibble selects the hardware variant: the
   * firmware reads 5 as OK_HW_COLOR (the NeoPixel build) and 9 as OK_HW_DUO.
   */
  *reg32(kSIM_SDID) = 0x00000005;

  /* A stable fake 128-bit chip UID, so derived device keys are stable too. */
  *reg32(kSIM_UIDH)  = 0x4F4B454D; /* "OKEM" */
  *reg32(kSIM_UIDMH) = 0x554C4154; /* "ULAT" */
  *reg32(kSIM_UIDML) = 0x4F520001;
  *reg32(kSIM_UIDL)  = 0x00000001;

  /* CCIF set = "flash controller idle", so the firmware's wait loops exit. */
  *reg8(kFTFL_FSTAT) = 0x80;
}

}  // namespace

/* ------------------------------------------------------------ sinks */

extern "C" {

void okemu_set_stream_sink(okemu_stream_sink fn, void *ctx) {
  std::lock_guard<std::mutex> lk(g.mu); g.stream_sink = fn; g.stream_ctx = ctx;
}
void okemu_set_led_sink(okemu_led_sink fn, void *ctx) {
  std::lock_guard<std::mutex> lk(g.mu); g.led_sink = fn; g.led_ctx = ctx;
}

/* One funnel for every interface and direction. Snapshots the sink under the
 * lock, then calls it unlocked - the sink hops to the JS thread and must not
 * run with the HAL mutex held. */
static void stream_emit(const uint8_t *data, size_t len, int iface, int dir) {
  okemu_stream_sink fn; void *ctx;
  {
    std::lock_guard<std::mutex> lk(g.mu);
    fn = g.stream_sink; ctx = g.stream_ctx;
  }
  if (fn) fn(data, len, iface, dir, ctx);
}

/* --------------------------------------------------------- lifecycle */

int okemu_hal_init(const char *storage_dir, char *err, size_t errlen) {
  g.dir = storage_dir ? storage_dir : ".";
  mkdir(g.dir.c_str(), 0700);

  /* 1. register blocks --------------------------------------------------
   * Nothing to do: they are static arrays (okemu_regs.cpp), seeded by
   * okemu_map_peripherals() during module load. There is no mapping left
   * that could fail, and so no error to surface here. */

  /* 2. flash array, file-backed at its real address -------------------
   *
   * The firmware reads its own storage through raw pointers, and fw_hash()
   * walks from fwstartadr (0x6060). Mapping from 0 needs mmap_min_addr to be
   * lowered (or CAP_SYS_RAWIO). If we cannot, we still map everything from
   * mmap_min_addr up - which covers the whole storage area at 0x3A800 - and
   * mark the device as already provisioned so the one-time block that calls
   * fw_hash() never runs.
   */
  char e2[256];
  g.flash_fd = open_backing(g.dir, "flash.bin", OKEMU_FLASH_SIZE, 0xFF, e2, sizeof e2);
  if (g.flash_fd < 0) { snprintf(err, errlen, "%s", e2); return -1; }

  /*
   * mmap() treats addr==0 as "no hint" and picks an address of its own, even
   * with MAP_FIXED_NOREPLACE - so a request for base 0 can "succeed" somewhere
   * else entirely. Every mapping below is therefore checked against the
   * address we asked for, and anything else is unmapped and treated as a
   * failure.
   */
#ifdef _WIN32
  /*
   * WINDOWS PICKS THE ADDRESS AND WE TELL THE FIRMWARE WHICH.
   *
   * None of the rungs below are reachable here: the bottom 64 KB of every
   * Win32 process is the permanently reserved null-pointer guard, so 0 and
   * 0x1000 cannot be mapped at all, and 0x10000 is the rung the warning below
   * describes - certified_hw at 0x5BB0 unmapped, and every AES-GCM operation
   * faulting.
   *
   * Mapping relocatably removes the whole question. OKEMU_FLASH_BASE is a
   * variable on this platform (see ok_hal.h) and the firmware's four address
   * literals are rewritten as OKEMU_FLASH_BASE + offset by stage.js, so the
   * layout is identical and only the origin moves. Nothing is ever partially
   * mapped, so the degraded mode - and the warning - cannot arise.
   */
  bool low_mapped = true;
  size_t off = 0;
  {
    /*
     * THE ADDRESS MUST FIT IN 32 BITS.
     *
     * Letting Windows choose put the array at 0x0000011F_F9470000, and the
     * firmware promptly faulted at 0xF94AB003 - which is that base plus
     * 0x3B003, truncated to 32 bits. The firmware is 32-bit code: it stores
     * addresses in `unsigned long`, which is 64 bits on Linux (LP64) and 32
     * bits on Windows (LLP64), so every address it keeps loses its top half
     * here and nowhere else. See ok-rn/FINDING-64bit-pointer-narrowing.md.
     *
     * Retyping the firmware's address variables would be the thorough fix and
     * a very large patch. Putting the array below 4 GB makes the truncation a
     * no-op instead: the value round-trips, and the firmware's arithmetic is
     * correct as written.
     *
     * The search stays under 0x40000000, where the peripheral windows begin,
     * and steps by the 64 KB allocation granularity. MapViewOfFileEx fails
     * rather than relocating, so a success is always the address asked for.
     */
    void *wfp = MAP_FAILED;
    for (uintptr_t base = 0x10000000UL; base < 0x3F000000UL; base += 0x10000UL) {
      wfp = mmap((void *)base, OKEMU_FLASH_SIZE, PROT_READ | PROT_WRITE,
                 MAP_SHARED, g.flash_fd, 0);
      if (wfp != MAP_FAILED) break;
    }
    if (wfp == MAP_FAILED) {
      snprintf(err, errlen,
               "cannot map flash below 4GB: %s", strerror(errno));
      return -1;
    }
    okemu_flash_base = (uintptr_t)wfp;
    /* Relocatable mapping means a fault address says nothing on its own.
     * OKEMU_TRACE_MAP=1 prints the origin so an access violation can be read
     * as an offset into the firmware's own address map. */
    if (getenv("OKEMU_TRACE_MAP"))
      fprintf(stderr, "[okemu] flash mapped at %p (%lu KB)\n",
              wfp, (unsigned long)(OKEMU_FLASH_SIZE / 1024));
  }
#else
  bool low_mapped = true;
  size_t off = 0;
  void *fp = mmap((void *)OKEMU_FLASH_BASE, OKEMU_FLASH_SIZE,
                  PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED_NOREPLACE,
                  g.flash_fd, 0);
  if (fp != MAP_FAILED && (uintptr_t)fp != OKEMU_FLASH_BASE) {
    munmap(fp, OKEMU_FLASH_SIZE);
    fp = MAP_FAILED;
  }
  if (fp == MAP_FAILED) {
    /*
     * vm.mmap_min_addr blocks the bottom of the address space, so walk up
     * until something sticks. How far we get decides what works:
     *
     *   0x0000  everything, including fw_hash()'s walk from fwstartadr.
     *   0x1000  enough for real use. The firmware's own key material lives
     *           here - certified_hw is enckeysectoradr+432 = 0x5BB0 - and
     *           okcrypto_split_sundae() dereferences it on EVERY AES-GCM
     *           operation, so without this the device segfaults the moment it
     *           encrypts anything (e.g. storing a PIN). 4096 is the useful
     *           setting: it still leaves page 0 unmapped, so genuine NULL
     *           dereferences fault exactly as they should.
     *   0x10000 the unprivileged default. Storage at 0x3A800 is reachable and
     *           the device boots, but any crypto that touches certified_hw
     *           will crash. Usable only for HID/protocol work.
     */
    static const size_t kFallbacks[] = { 0x1000, 0x10000 };
    for (size_t i = 0; i < sizeof kFallbacks / sizeof *kFallbacks; i++) {
      off = kFallbacks[i];
      fp = mmap((void *)(OKEMU_FLASH_BASE + off), OKEMU_FLASH_SIZE - off,
                PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED_NOREPLACE,
                g.flash_fd, (off_t)off);
      if (fp != MAP_FAILED && (uintptr_t)fp == OKEMU_FLASH_BASE + off) break;
      if (fp != MAP_FAILED) { munmap(fp, OKEMU_FLASH_SIZE - off); fp = MAP_FAILED; }
    }
    if (fp == MAP_FAILED) {
      snprintf(err, errlen,
               "cannot map flash: %s - lower vm.mmap_min_addr "
               "(sudo sysctl -w vm.mmap_min_addr=4096)", strerror(errno));
      return -1;
    }
    low_mapped = false;

    if (off > 0x5BB0UL) {
      fprintf(stderr,
              "[okemu] WARNING: flash mapped from %#lx; the firmware's key "
              "material at 0x5BB0 (certified_hw) is NOT mapped.\n"
              "[okemu]          Crypto operations will crash. Run "
              "scripts/setup-permissions.sh, or:\n"
              "[okemu]          sudo sysctl -w vm.mmap_min_addr=4096\n",
              (unsigned long)off);
    }
  }
#endif /* _WIN32 */
  g.flash = (uint8_t *)OKEMU_FLASH_BASE;
  g.flash_mapped_off = off;

  /* 3. EEPROM --------------------------------------------------------- */
  g.eeprom_fd = open_backing(g.dir, "eeprom.bin", OKEMU_EEPROM_SIZE, 0xFF, e2, sizeof e2);
  if (g.eeprom_fd < 0) { snprintf(err, errlen, "%s", e2); return -1; }
  if (pread(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0) != OKEMU_EEPROM_SIZE)
    memset(g.eeprom, 0xFF, OKEMU_EEPROM_SIZE);

  /*
   * FSEC != 0x44 sends the firmware through its one-time provisioning path
   * (device-key derivation + fw_hash + lock). That path is only safe when the
   * whole flash array including fwstartadr (0x6060) is mapped.
   */
#ifdef _WIN32
  /*
   * ALREADY PROVISIONED, EVERY BOOT.
   *
   * FSEC is a flash-controller register: on hardware it is persistent, and
   * the firmware writes it once during provisioning so the one-time path
   * never runs again. Here it is plain mapped memory that starts fresh with
   * the process, so whatever we put in it is what the firmware believes on
   * EVERY boot - it cannot latch.
   *
   * low_mapped is true on Windows, because the whole 256 KB really is mapped.
   * Taking the 0xFF branch therefore sent the firmware through one-time
   * provisioning after every restart, which wipes the device: the test kit's
   * fixture set three PINs, rebooted to load them, and the device came back
   * UNLOCKED, NO PIN SET.
   *
   * 0x44 is what Linux uses at the 'crypto' rung and what every fixture in
   * the kit is written against. The cost is that the provisioning branch is
   * not exercised here - fw-hash and attestation - which is exactly the
   * trade Linux already makes, and capabilities.js reports this host as
   * 'crypto' for that reason.
   */
  *reg8(kFTFL_FSEC) = 0x44;
#else
  *reg8(kFTFL_FSEC) = low_mapped ? 0xFF : 0x44;
#endif

  okemu_time_start();
  okemu_systick_start();   /* millis() must advance without the firmware asking */
  return 0;
}

/*
 * The SysTick tick.
 *
 * millis() is a static inline in core_pins.h that reads systick_millis_count
 * directly, so the only way to make it advance is to advance that counter. On
 * the MK20DX256 the SysTick interrupt does it at 1 kHz, completely
 * independently of what the main loop happens to be executing.
 *
 * Feeding it from micros() instead - as this did originally - looks equivalent
 * only while every waiting loop also polls micros(). payload() does not:
 *
 *     unsigned long wait = millis() + 200;
 *     while (millis() < wait) { recvmsg(0); }   // never calls micros()
 *
 * That loop runs on the successful-unlock path. With the counter frozen it
 * never terminated: RawHID kept being serviced from inside the loop, so the
 * device still answered status queries and looked healthy, while checkKey()
 * never returned and touch_sense_loop() - and with it the whole SEREMU debug
 * channel and every button - was dead from the moment the PIN was accepted.
 *
 * A dedicated thread is the honest emulation of a hardware timer interrupt.
 */
static std::thread      g_systick_thread;
static std::atomic<bool> g_systick_run{false};

void okemu_systick_start(void) {
  if (g_systick_run.exchange(true)) return;
  okemu_sync_systick();               /* don't start from zero */
  g_systick_thread = std::thread([] {
    while (g_systick_run.load(std::memory_order_relaxed)) {
      okemu_sync_systick();
      struct timespec t = { 0, 500000L };   /* 500 us - twice SysTick's rate */
      nanosleep(&t, NULL);
    }
  });
}

void okemu_systick_stop(void) {
  if (!g_systick_run.exchange(false)) return;
  if (g_systick_thread.joinable()) g_systick_thread.join();
}

void okemu_hal_shutdown(void) {
  okemu_systick_stop();
  if (g.eeprom_fd >= 0) {
    pwrite(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0);
    ::close(g.eeprom_fd);
    g.eeprom_fd = -1;
  }
  if (g.flash) {
    msync((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
          OKEMU_FLASH_SIZE - g.flash_mapped_off, MS_SYNC);
  }
  if (g.flash_fd >= 0) { ::close(g.flash_fd); g.flash_fd = -1; }
}

void okemu_factory_reset(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.flash) {
    memset((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off), 0xFF,
           OKEMU_FLASH_SIZE - g.flash_mapped_off);
    msync((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
          OKEMU_FLASH_SIZE - g.flash_mapped_off, MS_SYNC);
  }
  memset(g.eeprom, 0xFF, OKEMU_EEPROM_SIZE);
  if (g.eeprom_fd >= 0) pwrite(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0);
  g.restart = true;
}

int  okemu_restart_requested(void) { std::lock_guard<std::mutex> lk(g.mu); return g.restart; }
void okemu_clear_restart(void)     { std::lock_guard<std::mutex> lk(g.mu); g.restart = false; }
void okemu_request_restart(void)   { std::lock_guard<std::mutex> lk(g.mu); g.restart = true; }

/* -------------------------------------------------------------- time */

void okemu_time_start(void) { g.t0_us = now_us(); }

uint32_t okemu_micros(void) { return (uint32_t)(now_us() - g.t0_us); }

void okemu_delay_ms(uint32_t ms) {
  struct timespec ts;
  ts.tv_sec  = ms / 1000;
  ts.tv_nsec = (long)(ms % 1000) * 1000000L;
  nanosleep(&ts, nullptr);
  okemu_sync_systick();
}

/* ----------------------------------------------------------- buttons */

/*
 * Ported from ok-rn's android/okemu/src/ok_hal.cpp, where every claim below was
 * measured on its soft key. The pin table this replaced was the TOUCHPIN order,
 * so okemu_set_button(1) arrived as button 5 - see the first comment.
 */

/*
 * THE PIN ORDER IS NOT THE BUTTON ORDER. setup() assigns TOUCHPIN1..6 = pins
 * 1, 22, 23, 17, 15, 16 (OnlyKey.ino:268-273), but okcore.cpp:2574-2628 then
 * labels those pads in a DIFFERENT order - touchread1 is button 5 and
 * touchread3 is button 1:
 *
 *     touchread1 (pin  1) -> button 5      touchread4 (pin 17) -> button 3
 *     touchread2 (pin 22) -> button 2      touchread5 (pin 15) -> button 4
 *     touchread3 (pin 23) -> button 1      touchread6 (pin 16) -> button 6
 *
 * This table is indexed by BUTTON, which is what a caller means: the digits of
 * a PIN are button numbers, and so is a Confirm control. Seeding it with the
 * TOUCHPIN order instead - the obvious mistake, since the two lists hold the
 * same six pins - makes okemu_set_button(1) arrive as a press of button 5.
 * Measured, not reasoned about: the firmware answered a tap on 1 with
 * "password appended with 5".
 */
/*
 * A DUO SWAPS TWO OF THESE, and it swaps them in the firmware rather than in
 * the hardware.
 *
 * okcore.cpp's rngloop() reads the pads into six globals, and on a DUO two of
 * those reads are crossed:
 *
 *     if (onlykeyhw == OK_HW_DUO) {
 *         touchread2 = touchRead(TOUCHPIN5);
 *         touchread5 = touchRead(TOUCHPIN2);
 *     } else {
 *         touchread2 = touchRead(TOUCHPIN2);
 *         touchread5 = touchRead(TOUCHPIN5);
 *     }
 *
 * So on a DUO, "button 2" is whatever TOUCHPIN5 reports and "button 5" is
 * whatever TOUCHPIN2 reports. A host that holds button 2 against the classic
 * table is answering a pad the firmware is reading as button 5, and the press
 * is observed as nothing at all - measured, as "pressing button 2 registered as
 * null" on an emulated DUO.
 *
 * Read from `onlykeyhw` rather than baked in at build time, because that is the
 * same variable the firmware branches on: if its detection or its DEFINED_HWID
 * override ever changes, this follows rather than drifting. It is declared in
 * okcore.cpp and initialised to OK_HW_COLOR, so before the model is settled
 * this is the classic table - which is correct, since nothing is pressing
 * anything during calibration.
 */
/*
 * onlykeyhw is WEAK HERE, and that is a version fix.
 *
 * The 3.0 line declares it in okcore.cpp:168 (`uint8_t onlykeyhw =
 * OK_HW_COLOR;`) and branches on it wherever a DUO differs from a classic. THE
 * 2.1 LINE DOES NOT HAVE IT: that generation asks the chip directly, through
 * `#define HW_ID SIM_SDID_PINID` (onlykey.h:100), and the DUO did not exist -
 * its predecessor was OK_GO. So this file, which needs to know which pad map to
 * use, failed to LINK against v2.1.0 and v2.1.1 with `undefined symbol:
 * onlykeyhw`. Caught by the version matrix, which is what it is for.
 *
 * A weak definition is right in both directions. Where the firmware defines it,
 * its strong definition wins and the HAL follows whatever the staged build
 * decided - including a DUO, when OKEMU_MODEL=duo uncomments the firmware's own
 * DEFINED_HWID override. Where it does not, this supplies OK_HW_COLOR, which is
 * the only answer a 2.1 build can have: OK_HW_DUO is not a value that release
 * knows, no build option produces one, and a DUO cannot be staged from it.
 *
 * The literal rather than the constant, because onlykey.h is firmware and this
 * file is the HAL - see pin_for_button(), which cites the same line for the
 * same reason.
 */
__attribute__((weak)) uint8_t onlykeyhw = 5;   /* onlykey.h:105, OK_HW_COLOR */

#ifdef _WIN32
/*
 * A uint8_t VIEW OF AN int GLOBAL, the way every released firmware reads two of
 * them - kept on Windows without changing a declaration.
 *
 * The releases define `int Profile_Offset` and `int outputmode` (okcore.cpp)
 * but declare them `extern uint8_t` in password.cpp, okcrypto.cpp and the
 * sketch. On ARM and Linux a global's symbol is just its name, so those
 * declarations link to the int and read its low byte - which is what the
 * device behaves on: OnlyKey.ino stores -42 in Profile_Offset and the uint8_t
 * readers see 214. ok-rn keeps that deliberately (scripts/versions/_shared.js,
 * profileOffsetType): "correcting" the type to int would be a behaviour change
 * wearing a type fix, on firmware that is meant to run as it shipped.
 *
 * MSVC-style mangling puts the TYPE in the symbol - `?Profile_Offset@@3HA` for
 * the int, `?Profile_Offset@@3EA` for an unsigned char - so on Windows those
 * declarations name a symbol nobody defines, and lld-link failed every pinned
 * release with exactly two undefined symbols. /alternatename resolves each
 * uint8_t name to the int's address: the same low-byte read as everywhere
 * else, the declarations untouched. It is a FALLBACK, used only when the
 * uint8_t symbol is otherwise undefined, so a tree that declares them int (the
 * working tree) is unaffected.
 */
#pragma comment(linker, "/alternatename:?Profile_Offset@@3EA=?Profile_Offset@@3HA")
#pragma comment(linker, "/alternatename:?outputmode@@3EA=?outputmode@@3HA")

/*
 * The USB report buffers, C linkage to their C++ definition. core-override's
 * okemu_usb.cpp names setBuffer / getBuffer / keyboard_buffer with C linkage,
 * as the 3.0 line gives them (a C declaration precedes okcore.cpp's
 * definition). v2.1.1 defines them without one, so they are C++-mangled there
 * and lld-link found no `setBuffer`. Same fallback: only used when the C name
 * is otherwise undefined. Mangled names read from clang-cl's own output
 * (llvm-nm of `unsigned char setBuffer[9]`), not guessed.
 */
#pragma comment(linker, "/alternatename:setBuffer=?setBuffer@@3PAEA")
#pragma comment(linker, "/alternatename:getBuffer=?getBuffer@@3PAEA")
#pragma comment(linker, "/alternatename:keyboard_buffer=?keyboard_buffer@@3PAEA")
#endif

/*
 * A DUO HAS TWO PADS, AND ITS THIRD BUTTON IS BOTH AT ONCE.
 *
 * okcore.cpp's sense loop has no third branch for a DUO. It reads the two pads
 * as buttons 2 and 1, and each branch then checks whether THE OTHER one is
 * also held:
 *
 *     else if (touchread2 > ...) {
 *         button_selected = '2';
 *         if (onlykeyhw == OK_HW_DUO) {
 *             if (touchread3 > ...) { button_3_on++; button_3_off = 0; }
 *             else { button_3_off++; if (button_3_off > 2) button_3_on = 0; }
 *         }
 *     }
 *
 * - and symmetrically in the touchread3 branch. So "button 3" on a DUO is a
 * chord, not a pad. The `!= OK_HW_DUO` guards on the touchread1, 4, 5 and 6
 * branches say the same thing from the other side: those pads produce no button
 * at all on a DUO.
 *
 * A host that holds button 3 expecting a pad gets nothing, because there is
 * nothing there - measured, as "pressing button 3 registered as null".
 *
 * So an emulated DUO reports button 3 as both of its pads held. That is what a
 * finger on each does, and it is the only way the firmware's counter advances.
 */
static bool duo_button_holds_pin(uint8_t pin, const bool *button) {
  /* The DUO's two pads: TOUCHPIN3 (its button 1) and TOUCHPIN5 (its button 2). */
  const uint8_t kPadOne = 23;
  const uint8_t kPadTwo = 15;
  if (pin == kPadOne) return button[1] || button[3];
  if (pin == kPadTwo) return button[2] || button[3];
  return false;   /* no other pad produces a button on a DUO */
}

static uint8_t pin_for_button(int index) {
  /* Defined weakly above, so this links against a release without it. */
  const uint8_t OKEMU_HW_DUO = 9;   /* onlykey.h:104 */
  static const uint8_t kClassic[OKEMU_NUM_BUTTONS] = { 23, 22, 17, 15, 1, 16 };
  static const uint8_t kDuo[OKEMU_NUM_BUTTONS]     = { 23, 15, 17, 22, 1, 16 };
  return (onlykeyhw == OKEMU_HW_DUO ? kDuo : kClassic)[index];
}

/*
 * The pad rngloop() samples LAST in a round, and therefore the moment at which
 * one iteration of the sense path has fully observed the button state.
 *
 * touch_sense_loop() opens with rngloop() (okcore.cpp:2536), which reads
 * TOUCHPIN1, 2, 5, then 3, 4, 6 (okcore.cpp:2762-2775) - pin 16 last - and the
 * loop then evaluates those six globals and does key_on += 1. So one round of
 * touchRead() calls is exactly one tick of the firmware's own press counter,
 * and pin 16 is where a round ends.
 */
static const uint8_t kLastPinInRound = 16;

void okemu_set_button(int n, int down) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return;
  std::lock_guard<std::mutex> lk(g.mu);
  g.button[n] = down != 0;
  g.ticks[n] = 0;          /* an explicit hold outranks a counted one */
}

int okemu_get_button(int n) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return 0;
  std::lock_guard<std::mutex> lk(g.mu);
  return g.button[n] ? 1 : 0;
}

/*
 * Hold a button for a COUNT OF MAIN-LOOP ITERATIONS rather than for a wall
 * time, then release it.
 *
 * The firmware bands a press by how many iterations of touch_sense_loop() saw
 * the pad held - key_on += 1 per iteration, handed to payload() as the
 * duration argument (OnlyKey.ino:522,631) - and nothing in that path consults
 * a clock:
 *
 *     duration <= 20         gen_press()   types slot N
 *     duration 21 .. 89      gen_hold()    types slot N+6, the b profile
 *     duration >= 90         rejected, blink only
 *
 * and, above them and reached FIRST because each of those branches returns
 * before the band dispatch (OnlyKey.ino:873-914):
 *
 *     duration >= 72, button 1   backup()
 *     duration >= 72, button 2   get_key_labels()
 *     duration >= 72, button 3   lock + CPU_RESTART()
 *     duration >= 72, button 6   config mode
 *
 * So the only safe window for a b-profile read is 21..71, and asking for it in
 * milliseconds is a bet on how fast this particular handset runs the loop - a
 * number that has never been measured, and that differs per device, per build
 * and per whatever else the phone is doing. Overshooting does not fail
 * cleanly: it takes a backup, or restarts the key.
 *
 * Counting the samples ourselves removes the bet. N ticks is N iterations on
 * any device, so the band is a property of the call rather than of the timing.
 *
 * The one caveat, stated because it is invisible otherwise: rngloop() also
 * runs from calibration (okcore.cpp:6156) and from RNG2()'s entropy spin
 * (okcore.cpp:7637), and a round from either ages the counters without the
 * sense loop counting a tick. Neither overlaps a deliberate hold - both run
 * synchronously on the firmware thread, calibration at startup and RNG2 during
 * payload processing, which is after the release - but a hold that spanned one
 * would come out SHORT rather than long, i.e. it errs downward, away from the
 * destructive bands.
 */
void okemu_set_button_ticks(int n, int ticks) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return;
  std::lock_guard<std::mutex> lk(g.mu);
  if (ticks <= 0) { g.button[n] = false; g.ticks[n] = 0; return; }
  g.button[n] = true;
  g.ticks[n] = ticks;
}

int okemu_button_ticks_left(int n) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return 0;
  std::lock_guard<std::mutex> lk(g.mu);
  return g.ticks[n];
}

/*
 * Sense rounds completed since boot.
 *
 * Exposed because A RELEASE IS NOT A GAP IN TIME, it is a count of rounds in
 * which nothing was held, and a caller that wants two presses to arrive as two
 * presses has to be able to wait for them.
 *
 * touch_sense_loop() credits at most ONE pad per round - the branches are
 * else-ifs - and every one of them does key_off = 0 and key_on += 1
 * (okcore.cpp:2574-2628). A press is emitted only once key_off > 2
 * (okcore.cpp:2723), i.e. after three rounds in which no pad read as touched.
 * So two counted holds with no idle round between them are not two presses at
 * all: key_on keeps climbing across both, button_selected ends up as whichever
 * was seen last, and what payload() finally receives is ONE press whose
 * duration is the sum. Seven ten-tick taps become a single seventy-tick hold -
 * and eight of them clear 72, which on button 1 is backup() and on button 3 is
 * lock and CPU_RESTART().
 *
 * Counted in rounds rather than measured in milliseconds for the same reason
 * the holds are: the firmware never consults a clock, and how long a round
 * takes is a property of the handset. See
 * ok-rn's FINDING-counted-presses-merge-without-an-idle-gap.md.
 */
uint64_t okemu_rounds(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return g.rounds;
}

/*
 * The firmware baselines each pad at rest and treats a large positive excursion
 * as a touch, so we report a low idle value and a high one while held.
 */
int okemu_touch_for_pin(uint8_t pin) {
  std::lock_guard<std::mutex> lk(g.mu);

  /* onlykey.h:104 - see pin_for_button() and duo_button_holds_pin() above. */
  bool held = false;
  if (onlykeyhw == 9) {
    held = duo_button_holds_pin(pin, g.button);
  } else {
    for (int i = 0; i < OKEMU_NUM_BUTTONS; i++) {
      if (pin_for_button(i) == pin) { held = g.button[i + 1]; break; }
    }
  }

  /*
   * Report first, age the counters after.
   *
   * The last tick of a hold must still read as HELD for the round it retires
   * in, or the sense loop counts one fewer iteration than was asked for - and
   * a one-tick hold, the smallest thing anyone can ask for, would be observed
   * as no press at all. Releasing here takes effect from the next round.
   */
  if (pin == kLastPinInRound) {
    for (int n = 1; n <= OKEMU_NUM_BUTTONS; n++) {
      if (g.ticks[n] > 0 && --g.ticks[n] == 0) g.button[n] = false;
    }
    g.rounds++;
  }

  return held ? 6000 : 1000;
}

/* --------------------------------------------------------------- LED */

void okemu_led_set(int index, uint8_t r, uint8_t g_, uint8_t b) {
  if (index < 0 || index >= OKEMU_NUM_PIXELS) return;
  std::lock_guard<std::mutex> lk(g.mu);
  g.px[index].r = r; g.px[index].g = g_; g.px[index].b = b;
}

void okemu_led_show(void) {
  okemu_led_sink fn; void *ctx; okemu_rgb snap[OKEMU_NUM_PIXELS];
  {
    std::lock_guard<std::mutex> lk(g.mu);
    fn = g.led_sink; ctx = g.led_ctx;
    memcpy(snap, g.px, sizeof snap);
  }
  if (fn) fn(snap, OKEMU_NUM_PIXELS, ctx);
}

/* ------------------------------------------------------------ RawHID */

int okemu_hid_deliver(const uint8_t *data, size_t len, int iface) {
  if (iface == OKEMU_IFACE_SEREMU) {
    /* Debug console input: bytes, not 64-byte reports. */
    {
      std::lock_guard<std::mutex> lk(g.mu);
      for (size_t i = 0; i < len; i++) g.seremu_in.push_back(data[i]);
    }
    stream_emit(data, len, OKEMU_IFACE_SEREMU, OKEMU_DIR_IN);
    return 0;
  }
  if (iface != OKEMU_IFACE_FIDO && iface != OKEMU_IFACE_VENDOR)
    return -1;   /* keyboard is device -> host only */

  Hal::InPkt pkt;
  pkt.iface = iface;
  pkt.data.assign(64, 0);
  memcpy(pkt.data.data(), data, len < 64 ? len : 64);

  /*
   * Snapshot before handing the packet to the queue: push_back(std::move(pkt))
   * leaves pkt.data empty, so reading pkt.data.data() afterwards dereferences
   * null and takes the process down. Every inbound RawHID report hit this.
   */
  uint8_t snap[64];
  memcpy(snap, pkt.data.data(), 64);

  {
    std::lock_guard<std::mutex> lk(g.mu);
    g.hid_in.push_back(std::move(pkt));
  }
  g.hid_cv.notify_one();
  stream_emit(snap, sizeof snap, iface, OKEMU_DIR_IN);
  return 0;
}

/*
 * Mirrors OnlyKey-Firmware/usb_rawhid.c: drain the FIDO endpoint first, then
 * the vendor one, and return WHICH interface produced the packet. Returning a
 * byte count here would make the firmware reply on the wrong interface.
 */
int okemu_hid_recv(void *buf, uint32_t timeout) {
  std::unique_lock<std::mutex> lk(g.mu);
  if (g.hid_in.empty()) {
    if (timeout == 0) return 0;
    g.hid_cv.wait_for(lk, std::chrono::milliseconds(timeout),
                      [] { return !g.hid_in.empty(); });
    if (g.hid_in.empty()) return 0;
  }
  /* Prefer a FIDO packet if one is queued, matching the endpoint poll order. */
  auto it = g.hid_in.begin();
  for (auto i = g.hid_in.begin(); i != g.hid_in.end(); ++i) {
    if (i->iface == OKEMU_IFACE_FIDO) { it = i; break; }
  }
  memcpy(buf, it->data.data(), 64);
  int iface = it->iface;
  g.hid_in.erase(it);
  return iface;
}

int okemu_hid_pending(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  int n = 0;
  for (const auto &p : g.hid_in)
    if (p.iface == OKEMU_IFACE_FIDO) n += 64;
  return n;
}

void okemu_hid_flush_in(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  g.hid_in.clear();
}

int okemu_hid_emit(const uint8_t *data, size_t len, uint32_t /*timeout*/, int iface) {
  stream_emit(data, len, iface, OKEMU_DIR_OUT);
  return (int)len;
}

/* ---------------------------------------------------------- keyboard */

void okemu_kbd_emit(const uint8_t *report8) {
  stream_emit(report8, 8, OKEMU_IFACE_KEYBOARD, OKEMU_DIR_OUT);
}

/* --------------------------------------------------------------- log */

void okemu_log(const uint8_t *data, size_t len) {
  stream_emit(data, len, OKEMU_IFACE_SEREMU, OKEMU_DIR_OUT);
}

/* --- SEREMU input, backing Serial.read() on the firmware side --- */

int okemu_seremu_getc(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.seremu_in.empty()) return -1;
  int c = g.seremu_in.front();
  g.seremu_in.pop_front();
  return c;
}

int okemu_seremu_peek(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return g.seremu_in.empty() ? -1 : g.seremu_in.front();
}

int okemu_seremu_avail(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return (int)g.seremu_in.size();
}

void okemu_seremu_flush_in(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  g.seremu_in.clear();
}

/* EEPROM backing, used by the eeprom override. */
uint8_t okemu_eeprom_read(uint32_t addr) {
  if (addr >= OKEMU_EEPROM_SIZE) return 0xFF;
  std::lock_guard<std::mutex> lk(g.mu);
  return g.eeprom[addr];
}

void okemu_eeprom_write(uint32_t addr, uint8_t v) {
  if (addr >= OKEMU_EEPROM_SIZE) return;
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.eeprom[addr] == v) return;
  g.eeprom[addr] = v;
  if (g.eeprom_fd >= 0) pwrite(g.eeprom_fd, &v, 1, (off_t)addr);
}

/* ----------------------------------------------------------- entropy */

void okemu_random_bytes(uint8_t *out, size_t len) {
#ifdef _WIN32
  /*
   * WINDOWS HAS NO /dev/urandom, AND THE FALLBACK BELOW IS NOT AN RNG.
   *
   * The POSIX path treats a missing /dev/urandom as pathological and degrades
   * to now_us() smeared across the buffer. On Linux that branch is genuinely
   * unreachable. On Windows the open() could never succeed, so every call
   * would take it - and this function feeds key generation. Timestamp bytes
   * as key material is not a degraded mode, it is a broken device that still
   * answers.
   *
   * BCryptGenRandom with USE_SYSTEM_PREFERRED_RNG is the platform CSPRNG and
   * needs no algorithm handle. If it ever fails there is nothing safe left to
   * do, so abort rather than return something that looks like entropy.
   */
  if (BCryptGenRandom(NULL, out, (ULONG)len,
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0)
    return;
  fprintf(stderr, "[okemu] BCryptGenRandom failed - refusing to invent entropy\n");
  abort();
#else
  static int fd = -1;
  if (fd < 0) fd = ::open("/dev/urandom", O_RDONLY);
  if (fd >= 0) {
    size_t got = 0;
    while (got < len) {
      ssize_t n = ::read(fd, out + got, len - got);
      if (n <= 0) break;
      got += (size_t)n;
    }
    if (got == len) return;
  }
  /* /dev/urandom is effectively always available; this only guards against a
   * pathological fd exhaustion so the caller still gets varying bytes. */
  for (size_t i = 0; i < len; i++)
    out[i] = (uint8_t)(now_us() >> ((i % 8) * 8));
#endif
}

}  // extern "C"
