#include <cassert>
#include <cstdio>
#include "../native/double-shift.h"

int main() {
  DoubleShift taps;
  auto tap = [&](int key, double time, double duration = 0.06) {
    assert(!taps.shift(key, true, time));
    return taps.shift(key, false, time + duration);
  };
  assert(!tap(56, 1)); assert(tap(56, 1.2)); // left Shift
  assert(!tap(60, 2)); assert(tap(60, 2.2)); // right Shift
  assert(!tap(56, 3)); assert(!tap(60, 3.2)); // different Shift keys
  taps.reset();
  assert(!tap(56, 4)); assert(!tap(56, 5)); // too slow
  taps.reset();
  assert(!tap(56, 6, 0.5)); assert(!tap(56, 6.6)); // held key
  taps.reset();
  assert(!tap(56, 7)); taps.reset(); assert(!tap(56, 7.2)); // another key/click/focus
  taps.reset();
  assert(!taps.shift(56, true, 8));
  assert(!taps.shift(56, true, 8.01)); // repeats are not a tap
  assert(!taps.shift(56, false, 8.05));
  assert(!tap(56, 8.2));
  taps.reset();
  assert(!taps.shift(56, false, 9)); assert(!tap(56, 9.1)); // unmatched release
  taps.reset();
  assert(!tap(56, 10)); assert(tap(56, 10.2)); assert(!tap(56, 10.3)); // no overlapping pairs
  puts("Double Shift tests passed: both sides, timing, holds, repeats, interruption, and release pairing.");
}
