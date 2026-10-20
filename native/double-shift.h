#pragma once

// Times are monotonic seconds. Only complete, unaccompanied taps qualify.
class DoubleShift {
  int held = -1;
  int firstKey = -1;
  double pressedAt = 0;
  double releasedAt = 0;

public:
  void reset() { held = firstKey = -1; }

  bool shift(int key, bool down, double time) {
    if (down) {
      if (held != -1) { reset(); return false; }
      if (firstKey != key || time - releasedAt > 0.4 || time < releasedAt) firstKey = -1;
      held = key;
      pressedAt = time;
      return false;
    }
    if (held != key) { reset(); return false; }
    held = -1;
    if (time - pressedAt > 0.25 || time < pressedAt) { reset(); return false; }
    if (firstKey == key && time - releasedAt <= 0.4) { reset(); return true; }
    firstKey = key;
    releasedAt = time;
    return false;
  }
};
