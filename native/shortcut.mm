#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#include <node_api.h>
#include <memory>
#include <unistd.h>
#include "double-shift.h"

namespace {
struct Monitor {
  napi_threadsafe_function callback = nullptr;
  __strong id global = nil;
  __strong id local = nil;
  __strong id activation = nil;
  DoubleShift taps;
  pid_t pid = 0;
};
Monitor *current = nullptr;

void stop() {
  Monitor *monitor = current;
  if (!monitor) return;
  current = nullptr;
  if (monitor->global) [NSEvent removeMonitor:monitor->global];
  if (monitor->local) [NSEvent removeMonitor:monitor->local];
  if (monitor->activation) [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:monitor->activation];
  monitor->global = monitor->local = monitor->activation = nil;
  // The finalizer owns the context until any queued JS callbacks have drained.
  napi_release_threadsafe_function(monitor->callback, napi_tsfn_abort);
}

void observe(Monitor *monitor, NSEvent *event) {
  if (current != monitor) return;
  pid_t pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  if (pid != monitor->pid) { monitor->taps.reset(); monitor->pid = pid; }
  if (pid == getpid() || !AXIsProcessTrusted()) { monitor->taps.reset(); return; }
  if (event.type != NSEventTypeFlagsChanged || (event.keyCode != 56 && event.keyCode != 60)) {
    monitor->taps.reset(); return;
  }
  const auto others = NSEventModifierFlagCommand | NSEventModifierFlagControl |
                      NSEventModifierFlagOption | NSEventModifierFlagFunction;
  const auto shifts = NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK;
  if ((event.modifierFlags & others) || (event.modifierFlags & shifts) == shifts) {
    monitor->taps.reset(); return;
  }
  const auto mask = event.keyCode == 56 ? NX_DEVICELSHIFTKEYMASK : NX_DEVICERSHIFTKEYMASK;
  bool down = (event.modifierFlags & mask) != 0;
  bool trigger = monitor->taps.shift(event.keyCode, down, event.timestamp);
  if (trigger) {
    auto *origin = new pid_t(pid);
    if (napi_call_threadsafe_function(monitor->callback, origin, napi_tsfn_nonblocking) != napi_ok) delete origin;
  }
}

napi_value start(napi_env env, napi_callback_info info) {
  napi_value callback, result;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "A capture callback is required."); return nullptr;
  }
  if (current) { napi_get_boolean(env, true, &result); return result; }
  if (!AXIsProcessTrusted()) { napi_get_boolean(env, false, &result); return result; }
  auto *monitor = new Monitor;
  napi_value name;
  napi_create_string_utf8(env, "Double Shift capture", NAPI_AUTO_LENGTH, &name);
  auto status = napi_create_threadsafe_function(env, callback, nullptr, name, 1, 1, monitor,
    [](napi_env, void *data, void *) { delete static_cast<Monitor *>(data); }, monitor,
    [](napi_env env, napi_value callback, void *context, void *data) {
      std::unique_ptr<pid_t> origin(static_cast<pid_t *>(data));
      if (!env || current != context || !origin ||
          NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != *origin) return;
      napi_value receiver, ignored;
      napi_get_undefined(env, &receiver);
      napi_call_function(env, receiver, callback, 0, nullptr, &ignored);
    }, &monitor->callback);
  if (status != napi_ok) { delete monitor; napi_get_boolean(env, false, &result); return result; }
  napi_unref_threadsafe_function(env, monitor->callback);
  current = monitor;
  const auto events = NSEventMaskFlagsChanged | NSEventMaskKeyDown |
                      NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown;
  monitor->global = [NSEvent addGlobalMonitorForEventsMatchingMask:events handler:^(NSEvent *event) {
    observe(monitor, event);
  }];
  monitor->local = [NSEvent addLocalMonitorForEventsMatchingMask:events handler:^NSEvent *(NSEvent *event) {
    observe(monitor, event);
    return event; // Never consume or alter typing in either application.
  }];
  monitor->activation = [NSWorkspace.sharedWorkspace.notificationCenter
    addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:nil
    usingBlock:^(NSNotification *) { if (current == monitor) monitor->taps.reset(); }];
  bool installed = monitor->global && monitor->local;
  if (!installed) stop();
  napi_get_boolean(env, installed, &result);
  return result;
}

napi_value stopCallback(napi_env env, napi_callback_info) {
  stop();
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}
}

void installShortcutExports(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "startDoubleShift", NAPI_AUTO_LENGTH, start, nullptr, &function);
  napi_set_named_property(env, exports, "startDoubleShift", function);
  napi_create_function(env, "stopDoubleShift", NAPI_AUTO_LENGTH, stopCallback, nullptr, &function);
  napi_set_named_property(env, exports, "stopDoubleShift", function);
  napi_add_env_cleanup_hook(env, [](void *) { stop(); }, nullptr);
}
