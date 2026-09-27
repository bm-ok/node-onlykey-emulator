/*
 * The press queue. See okemu_press.h for why this exists and what it is not.
 */
#include "okemu_press.h"

#include <mutex>

namespace {

struct Queued {
  uint8_t  button;
  uint16_t ticks;
};

struct State {
  std::mutex mu;
  Queued  q[OKEMU_PRESS_QUEUE_MAX];
  int     head = 0;   /* next to hand over */
  int     tail = 0;   /* next free slot    */
  int     count = 0;
};

State g;

}  // namespace

extern "C" int okemu_press_queue(const uint8_t *buttons, const uint16_t *ticks,
                                 int n) {
  if (!buttons || !ticks || n <= 0) return 0;

  std::lock_guard<std::mutex> lk(g.mu);
  int taken = 0;
  for (int i = 0; i < n; i++) {
    if (g.count >= OKEMU_PRESS_QUEUE_MAX) break;
    /*
     * Six buttons, and a zero-tick press is not a press. Both are refused
     * here as well as in index.js, because this is reachable from anywhere and a
     * button of 0 would reach payload() as a selection nothing matches.
     */
    if (buttons[i] < 1 || buttons[i] > 6 || ticks[i] == 0) continue;

    g.q[g.tail].button = buttons[i];
    g.q[g.tail].ticks  = ticks[i];
    g.tail = (g.tail + 1) % OKEMU_PRESS_QUEUE_MAX;
    g.count++;
    taken++;
  }
  return taken;
}

extern "C" int okemu_press_pending(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return g.count;
}

extern "C" void okemu_press_take(int *button_selected, int *key_press) {
  if (!button_selected || !key_press) return;

  /*
   * CHEAP WHEN THERE IS NOTHING TO DO, because this runs on every sense round
   * for the life of the process. The common case is an unlocked reader taking
   * the mutex, seeing zero, and leaving.
   */
  if (*key_press != 0) return;   /* the loop still holds one; do not clobber */

  std::lock_guard<std::mutex> lk(g.mu);
  if (g.count == 0) return;

  const Queued &next = g.q[g.head];
  /*
   * The firmware reports the selection as a CHARACTER - touch_sense_loop
   * assigns button_selected = '1'..'6' - and payload() compares it that way.
   * A raw 1..6 would match nothing and the press would vanish silently.
   */
  *button_selected = '0' + next.button;
  *key_press = next.ticks;

  g.head = (g.head + 1) % OKEMU_PRESS_QUEUE_MAX;
  g.count--;
}

extern "C" void okemu_press_clear(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  g.head = g.tail = g.count = 0;
}
