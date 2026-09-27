/*
 * okemu_press - button presses handed to the firmware, rather than sensed.
 *
 * ## Why this exists
 *
 * The other way to press a button here is okemu_set_button_ticks(), which
 * emulates a FINGER: the pad reads high for N rounds and touch_sense_loop()
 * counts them. That is a faithful emulation and it is what the press-band
 * tests exercise, but it is expensive, because a round only happens when the
 * firmware's scheduler runs checkKey() - `Task taskKey(TIME_POLL, checkKey)`
 * with `#define TIME_POLL 50`. A ten-tick tap plus the four idle rounds the
 * firmware needs to see the release is fourteen scheduler periods. Measured in
 * ok-rn's soft key on a Pixel 6a, where this file comes from: 757-855ms for ONE
 * press, so a seven-digit PIN took five to six seconds of a person's time.
 *
 * The firmware itself shows the cheaper way, in the console parser it compiles
 * only under `#ifdef DEBUG`:
 *
 *     if (key_press == 0 && dbgQueueNext < dbgQueueLen) {
 *             button_selected = dbgQueueButton[dbgQueueNext];
 *             key_press       = dbgQueueDuration[dbgQueueNext];
 *             dbgQueueNext++;
 *     }
 *
 * It does not sense anything. `key_press` IS the duration touch_sense_loop()
 * returns and payload() bands on, so writing it directly produces exactly the
 * press the bands describe - and there is nothing to wait for.
 *
 * ## This is not that interface
 *
 * That block is behind `#ifdef DEBUG` and exists only in the development tree;
 * no released firmware in the version matrix contains it, and the `Serial`
 * channel it reads from is compiled out of a production build entirely. So it
 * is a MODEL, not something to switch on. Nothing here touches `Serial`,
 * SEREMU, or the DEBUG gate: this file is compiled unconditionally and works
 * against a firmware built exactly the way it ships.
 *
 * The emulator used to press buttons THROUGH that console - pressButtons()
 * wrote "1#128\n" to SEREMU - so on a production build every press, and every
 * GUI button that relied on one, silently did nothing. This replaced it.
 *
 * ## The one thing the firmware has to do
 *
 * `key_press` and `key_off` are function-local statics inside
 * touch_sense_loop(), which is why the firmware's own queue lives in there
 * too. So one line is injected at stage time, immediately before the existing
 * dispatch, and it is the only firmware change this needs:
 *
 *     okemu_press_take(&button_selected, &key_press);
 *     if ((key_press > 0) && (key_off > 2)) {
 *
 * Passing them in, rather than reaching for the firmware's symbols from here,
 * keeps this file free of firmware linkage entirely - and means the hand-over
 * happens ON THE FIRMWARE THREAD, which is what makes it safe to write a plain
 * int that the same thread is about to read.
 */
#ifndef OKEMU_PRESS_H
#define OKEMU_PRESS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** As many presses as may be waiting at once. A PIN is at most ten. */
#define OKEMU_PRESS_QUEUE_MAX 32

/**
 * Queue a run of presses.
 *
 * @param buttons  one per press, 1-6, as touch_sense_loop reports them
 * @param ticks    the DURATION of each, in the firmware's own unit - the
 *                 same number payload() bands on, so 10 types a slot and 72
 *                 is a gesture. Choosing a safe duration is the caller's
 *                 job, done in index.js, which maps the named hold tiers.
 * @param n        how many
 * @returns how many were accepted; short of `n` means the queue was full.
 */
int okemu_press_queue(const uint8_t *buttons, const uint16_t *ticks, int n);

/** Queued but not yet handed over. 0 means the firmware has taken them all. */
int okemu_press_pending(void);

/**
 * Hand ONE press to the loop, if it is ready for one.
 *
 * Called from inside touch_sense_loop() on the firmware thread. Does nothing
 * while `*key_press` is non-zero - the firmware is still holding a press it
 * has not dispatched, and overwriting it would lose a digit. That is the same
 * rule the firmware's own debug queue uses.
 */
void okemu_press_take(int *button_selected, int *key_press);

/** Forget anything queued. Used on stop, so a restart inherits no presses. */
void okemu_press_clear(void);

#ifdef __cplusplus
}
#endif

#endif /* OKEMU_PRESS_H */
