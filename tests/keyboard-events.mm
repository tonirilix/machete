// Test-only event emitter. Loaded by the trusted packaged app's inspector so
// the test runner does not need a separate Accessibility grant.
#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#include <node_api.h>

napi_value postKey(napi_env env, napi_callback_info info) {
  napi_value args[4], value;
  size_t argc = 4;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  uint32_t code = 0, flags = 0, target = 0;
  bool down = false;
  if (argc != 4 || napi_get_value_uint32(env, args[0], &code) != napi_ok ||
      napi_get_value_bool(env, args[1], &down) != napi_ok ||
      napi_get_value_uint32(env, args[2], &flags) != napi_ok ||
      napi_get_value_uint32(env, args[3], &target) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected key code, down state, flags, and fixture PID."); return nullptr;
  }
  // Always permit releasing a test Shift key, even if focus changed mid-test.
  if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != target &&
      !((code == 56 || code == 60) && !down)) {
    NSString *message = [NSString stringWithFormat:@"The selection fixture lost focus (expected %u, actual %d; key %u, down %d); refusing to send test keystrokes.", target, NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, code, down];
    napi_throw_error(env, nullptr, message.UTF8String); return nullptr;
  }
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
  CGEventRef event = CGEventCreateKeyboardEvent(source, code, down);
  if (event) {
    if (code == 56 || code == 60) CGEventSetType(event, kCGEventFlagsChanged);
    CGEventSetFlags(event, flags);
    CGEventPost(kCGSessionEventTap, event);
    CFRelease(event);
  }
  if (source) CFRelease(source);
  napi_get_undefined(env, &value);
  return value;
}
napi_value initialize(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "postKey", NAPI_AUTO_LENGTH, postKey, nullptr, &fn);
  napi_set_named_property(env, exports, "postKey", fn);
  return exports;
}
NAPI_MODULE(keyboard_events, initialize)
