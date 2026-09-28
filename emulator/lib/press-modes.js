/*
 * press-modes.js - the ONE place a press mode becomes a firmware duration.
 *
 * PRESS MODES, NOT TICKS. A caller - the UI, the CLI, IPC - says which kind of
 * press it means, and only this table knows what that is in the firmware's own
 * unit. Tick counts in the interface were the problem: every GUI picked its
 * own numbers and landed in whichever band they happened to fall in (the old
 * 'hold' was 128, which is a gesture, and nothing could type the b profile).
 *
 *   tap    types slot N              PRESS_TICKS.TAP      (<= 20)
 *   press  types slot N+6, profile b PRESS_TICKS.HOLD     (21..71)
 *   hold   the button's gesture      PRESS_TICKS.GESTURE  (>= 72): backup on 1,
 *          labels on 2, lock + restart on 3, config mode on 6
 *
 * The numbers and the band arithmetic come from node-onlykey-lib - the same
 * table ok-rn's soft key and every other GUI use: one lib, any GUI. The names
 * are the ones ok-rn's keypad shows. The deeper firmware bands (>=140 labels,
 * >=180 DUO config, >=360 DUO factory default) have no mode yet; a Classic
 * does not need them.
 *
 * Pure JS with no native addon, so the NW.js UI can load it as well as
 * index.js - the UI decides the mode from its own timer (modeForHeldMs) and
 * sends only the mode.
 */
'use strict';

/*
 * `node-onlykey-lib/device/press`, NOT `node-onlykey-lib/device`. The whole
 * device namespace needs @noble/* - installed in the lib's own node_modules on
 * one host and not on another (the Pi) - and the emulator failed to start
 * there over a table it needs no crypto for. The press subpath is press.js
 * alone, no dependencies. (Before the lib exported it, this walked from the
 * entry point to src/device/press.js - reaching past the exports map, which
 * no GUI may do.)
 */
const { PRESS_TICKS, GESTURES, bandFor } = require('node-onlykey-lib/device/press');

const MODE_TICKS = Object.freeze({
  tap: PRESS_TICKS.TAP,
  press: PRESS_TICKS.HOLD,
  hold: PRESS_TICKS.GESTURE,
});

const PRESS_MODES = Object.freeze(Object.keys(MODE_TICKS));

/* The lib names its bands by what the FIRMWARE does; the modes by what a
 * person does. ok-rn's keypad shows the same relabelling. */
const MODE_FOR_BAND = Object.freeze({ tap: 'tap', hold: 'press', gesture: 'hold' });

/*
 * checkKey() runs at `#define TIME_POLL 50`, so a finger held for N x 50 ms is
 * an N-tick press on hardware. ok-rn's keypad times the same way.
 */
const HOLD_TICK_MS = 50;

/*
 * Past REJECTED the firmware refuses a press outright, so a held button stops
 * one tick short of it: holding longer stays 'hold' and never sends twice.
 */
const HOLD_CEILING = PRESS_TICKS.REJECTED - 1;

/**
 * The mode a person meant by holding a button for `ms` milliseconds.
 *
 * Read from the wall clock, not by counting timer firings - ok-rn measured an
 * interval counter running ~30% short, which put presses in the wrong band.
 * @param {number} ms
 * @returns {'tap'|'press'|'hold'}
 */
function modeForHeldMs(ms) {
  const ticks = Math.min(Math.floor(Math.max(0, ms) / HOLD_TICK_MS), HOLD_CEILING);
  return MODE_FOR_BAND[bandFor(ticks)];
}

/** What a hold of button n does, or null - for the UI's live label. */
function gestureFor(n) {
  return GESTURES[n] || null;
}

module.exports = {
  MODE_TICKS,
  PRESS_MODES,
  HOLD_TICK_MS,
  modeForHeldMs,
  bandFor,        /* the lib's, re-exported so callers need not reach for it */
  gestureFor,
};
