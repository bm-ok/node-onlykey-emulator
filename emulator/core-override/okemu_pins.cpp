/*
 * okemu_pins.cpp - host replacement for the teensy3 core's pins_teensy.c,
 * analog.c and touch.c.
 *
 * Teensy's millis() is a static inline that reads `systick_millis_count`
 * directly (core_pins.h), so rather than intercept millis() we simply keep
 * that counter fed from the host monotonic clock.
 *
 * GPIO is a no-op: the only pins the firmware drives are the NeoPixel data
 * line (handled by the Adafruit_NeoPixel shim) and the bootloader-request
 * pin 33, which must read high or checkKey() would reboot into the bootloader
 * on the first poll.
 */
#include <stdint.h>
#include <time.h>
#include <stdlib.h>

/*
 * Deliberately not <thread>/<chrono>. This target is compiled as gnu++11 -
 * the firmware is C++11 code and raising it changes language rules it relies
 * on - and the MSVC STL requires C++17 or newer, so pulling <chrono> in here
 * fails inside <ctime> with a wall of "no member named 'clock_t' in the
 * global namespace". The sleep below is two lines either way; the standard
 * library is not worth that.
 */
#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  define NOMINMAX
#  include <windows.h>
#endif

#include "ok_hal.h"

extern "C" {

/* --------------------------------------------------------------- time */

volatile uint32_t systick_millis_count = 0;

/*
 * Written by both the SysTick thread and the firmware thread, so only ever
 * move it forward - a stale write going backwards would break the overflow
 * arithmetic in SoftTimerClass::testAndCall(). Signed difference so the
 * comparison stays correct across the 32-bit wrap, exactly as the firmware's
 * own millis() comparisons do.
 */
void okemu_sync_systick(void) {
  const uint32_t ms = okemu_micros() / 1000u;
  if ((int32_t)(ms - systick_millis_count) > 0) systick_millis_count = ms;
}

/*
 * micros() is also where the emulator gives the CPU back.
 *
 * SoftTimerClass::run() is `while (true) { for each task: testAndCall(task) }`
 * - it never returns, and testAndCall() polls micros() for every task on every
 * pass. That is the correct shape for a bare-metal main loop, but on a host it
 * pegs a core at 100% doing nothing.
 *
 * Since the scheduler's only interaction with the outside world between due
 * tasks is this call, throttling here converts the busy-wait into a low-rate
 * poll without touching SoftTimer or the firmware. micros() still returns the
 * true host time; we simply decline to answer thousands of times a
 * millisecond.
 *
 * The sleep is skipped whenever real time has advanced, so code that is
 * actually waiting out an interval (delay(), the fade loops) runs at full
 * speed - only spinning callers pay. 250 us is far below the 50 ms task
 * period, so scheduling resolution is unaffected.
 */
static const uint32_t OKEMU_MICROS_THROTTLE_US =
    getenv("OKEMU_THROTTLE_US") ? (uint32_t)atoi(getenv("OKEMU_THROTTLE_US")) : 250;

uint32_t micros(void) {
  static uint32_t last_us = 0;
  uint32_t now = okemu_micros();

  if (now - last_us < OKEMU_MICROS_THROTTLE_US) {
    /*
     * Windows has no nanosleep, and its scheduler tick is ~15.6 ms by
     * default, so a 250 us request sleeps for roughly one tick instead.
     *
     * That is fine, and worth saying why rather than reaching for
     * timeBeginPeriod: this sleep exists to stop SoftTimer's busy-wait
     * pegging a core, not to time anything. Oversleeping costs poll rate only
     * while the firmware has nothing to do, because the sleep is skipped
     * entirely whenever real time has advanced - so a caller genuinely
     * waiting out an interval still runs at full speed. The effective poll
     * rate becomes ~64 Hz rather than ~4 kHz, still far inside the 50 ms task
     * period. Raising the system timer resolution to buy back the difference
     * would be a machine-wide side effect for an emulator's idle loop.
     */
#ifdef _WIN32
    Sleep(OKEMU_MICROS_THROTTLE_US / 1000u + 1u);
#else
    struct timespec idle = { 0, OKEMU_MICROS_THROTTLE_US * 1000L };
    nanosleep(&idle, NULL);
#endif
    now = okemu_micros();
  }
  last_us = now;

  okemu_sync_systick();
  return now;
}

void delay(uint32_t ms) {
  okemu_delay_ms(ms);
}

void yield(void) {
  /* The firmware never blocks on USB the way the Teensy core does; keeping
   * the millisecond counter current is all any caller needs here. */
  okemu_sync_systick();
}

/* --------------------------------------------------------------- GPIO */

void pinMode(uint8_t /*pin*/, uint8_t /*mode*/) {}

void digitalWrite(uint8_t /*pin*/, uint8_t /*val*/) {}

uint8_t digitalRead(uint8_t pin) {
  /*
   * Pin 33 (PTA4) low for 3 s is the "jump to bootloader" request. It is
   * pulled up on real hardware; reporting low here would make the firmware
   * flag a firmware load and restart on startup.
   */
  (void)pin;
  return 1;
}

void analogWrite(uint8_t /*pin*/, int /*val*/) {}
void analogWriteRes(uint32_t /*bits*/) {}
void analogWriteFrequency(uint8_t /*pin*/, float /*frequency*/) {}
void analogWriteDAC0(int /*val*/) {}
void analogWriteDAC1(int /*val*/) {}

/* ------------------------------------------------------------- analog */

static uint32_t s_analog_res = 10;

void analogReadRes(unsigned int bits) {
  s_analog_res = bits ? bits : 10;
}

void analogReadAveraging(unsigned int /*num*/) {}

/*
 * setup() seeds entropy from ANALOGPIN1/ANALOGPIN2 (floating ADC inputs). On
 * hardware those read as noise, and that noise is folded into device key
 * derivation, so returning a constant would weaken the emulated device in a
 * way that is easy to miss. Draw from the OS CSPRNG instead.
 */
int analogRead(uint8_t /*pin*/) {
  uint32_t v = 0;
  okemu_random_bytes((uint8_t *)&v, sizeof v);
  const uint32_t mask = (s_analog_res >= 32) ? 0xFFFFFFFFu
                                             : ((1u << s_analog_res) - 1u);
  return (int)(v & mask);
}

/* -------------------------------------------------------------- touch */

int touchRead(uint8_t pin) {
  return okemu_touch_for_pin(pin);
}

}  // extern "C"
