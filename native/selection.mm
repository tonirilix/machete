#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>
#include <chrono>
#include <string>
#include <thread>
#include <unistd.h>
#include "pasteboard.h"

void installShortcutExports(napi_env env, napi_value exports);

namespace {
constexpr NSUInteger maxTextLength = 1000000; // Same UTF-16 limit as MAX_CLIP_LENGTH.
using Clock = std::chrono::steady_clock;
void pause(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

pid_t frontmostPid() {
  __block pid_t pid = 0;
  auto read = ^{ pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier; };
  if (NSThread.isMainThread) read();
  else dispatch_sync(dispatch_get_main_queue(), read);
  return pid;
}

struct Capture {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  pid_t pid = 0;
  std::string status = "unavailable";
  std::string text;
};

void setText(Capture &capture, NSString *text) {
  if (text.length > maxTextLength) { capture.status = "too-large"; return; }
  if (!text.length) { capture.status = "no-selection"; return; }
  NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:YES];
  capture.text.assign(static_cast<const char *>(data.bytes), data.length);
  capture.status = "captured";
}

bool readAccessibility(Capture &capture) {
  AXUIElementRef application = AXUIElementCreateApplication(capture.pid);
  AXUIElementSetMessagingTimeout(application, 0.25);
  CFTypeRef focused = nullptr;
  AXError error = AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute, &focused);
  if (error != kAXErrorSuccess) {
    // Electron apps expose their tree on demand to assistive clients.
    AXUIElementSetAttributeValue(application, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
    error = AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute, &focused);
  }
  CFRelease(application);
  if (error != kAXErrorSuccess || !focused) return false;
  if (CFGetTypeID(focused) != AXUIElementGetTypeID()) { CFRelease(focused); return false; }
  AXUIElementRef element = (AXUIElementRef)focused;
  AXUIElementSetMessagingTimeout(element, 0.25);
  CFTypeRef subrole = nullptr;
  if (AXUIElementCopyAttributeValue(element, kAXSubroleAttribute, &subrole) == kAXErrorSuccess) {
    bool secure = CFEqual(subrole, CFSTR("AXSecureTextField"));
    CFRelease(subrole);
    if (secure) { CFRelease(element); capture.status = "no-selection"; return true; }
  }
  CFTypeRef selected = nullptr;
  error = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute, &selected);
  CFRelease(element);
  if (error != kAXErrorSuccess || !selected) return false;
  bool readable = CFGetTypeID(selected) == CFStringGetTypeID();
  if (readable) setText(capture, (__bridge NSString *)selected);
  CFRelease(selected);
  return readable;
}

void copyFallback(Capture &capture) {
  // Wait for the actual capture shortcut's modifiers to be released so Copy
  // cannot accidentally become Shift+Command+C in the source application.
  auto releaseDeadline = Clock::now() + std::chrono::seconds(2);
  const auto modifiers = kCGEventFlagMaskCommand | kCGEventFlagMaskShift |
                         kCGEventFlagMaskControl | kCGEventFlagMaskAlternate;
  while (CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) & modifiers) {
    if (Clock::now() >= releaseDeadline) { capture.status = "keys-held"; return; }
    pause(15);
  }
  if (frontmostPid() != capture.pid) { capture.status = "source-changed"; return; }
  NSPasteboard *board = NSPasteboard.generalPasteboard;
  PasteboardSnapshot snapshot;
  if (!snapshotPasteboard(board, snapshot)) { capture.status = "clipboard-unavailable"; return; }
  if (frontmostPid() != capture.pid || board.changeCount != snapshot.changeCount) {
    capture.status = "source-changed"; return;
  }
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
  CGEventRef down = CGEventCreateKeyboardEvent(source, 8, true); // ANSI C
  CGEventRef up = CGEventCreateKeyboardEvent(source, 8, false);
  if (!down || !up) {
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    if (source) CFRelease(source);
    return;
  }
  CGEventSetFlags(down, kCGEventFlagMaskCommand);
  CGEventSetFlags(up, kCGEventFlagMaskCommand);
  CGEventPostToPid(capture.pid, down);
  CGEventPostToPid(capture.pid, up);
  CFRelease(down); CFRelease(up);
  if (source) CFRelease(source);

  auto deadline = Clock::now() + std::chrono::milliseconds(1200);
  while (board.changeCount == snapshot.changeCount && Clock::now() < deadline) pause(20);
  if (board.changeCount == snapshot.changeCount) { capture.status = "no-selection"; return; }
  NSInteger copiedCount = board.changeCount;
  // Do not adopt another clipboard owner while waiting for Copy's data.
  // A later change may be a new user copy, which must never be restored over.
  auto settleDeadline = Clock::now() + std::chrono::milliseconds(80);
  while (Clock::now() < settleDeadline) {
    pause(10);
    if (board.changeCount != copiedCount) { capture.status = "clipboard-busy"; return; }
  }
  @try {
    NSString *text = [board stringForType:NSPasteboardTypeString];
    if (board.changeCount != copiedCount) { capture.status = "clipboard-busy"; return; }
    if (frontmostPid() == capture.pid) setText(capture, text);
    else capture.status = "source-changed";
  } @finally {
    if (frontmostPid() == capture.pid &&
        restorePasteboard(board, snapshot, copiedCount) == PasteboardRestore::Failed) {
      capture.status = "restore-failed";
      capture.text.clear();
    }
  }
}

void execute(napi_env, void *data) {
  auto &capture = *static_cast<Capture *>(data);
  @autoreleasepool {
    @try {
      if (!AXIsProcessTrusted()) { capture.status = "permission-required"; return; }
      if (capture.pid <= 0 || capture.pid == getpid()) { capture.status = "no-selection"; return; }
      if (frontmostPid() != capture.pid) { capture.status = "source-changed"; return; }
      if (!readAccessibility(capture)) copyFallback(capture);
      if (capture.status == "captured" && frontmostPid() != capture.pid) {
        capture.status = "source-changed"; capture.text.clear();
      }
    } @catch (NSException *) { capture.status = "unavailable"; capture.text.clear(); }
  }
}

void complete(napi_env env, napi_status status, void *data) {
  auto *capture = static_cast<Capture *>(data);
  napi_value result, value;
  napi_create_object(env, &result);
  const char *name = status == napi_ok ? capture->status.c_str() : "unavailable";
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "status", value);
  napi_create_string_utf8(env, capture->text.data(), capture->text.size(), &value);
  napi_set_named_property(env, result, "text", value);
  napi_resolve_deferred(env, capture->deferred, result);
  napi_delete_async_work(env, capture->work);
  delete capture;
}

napi_value captureSelection(napi_env env, napi_callback_info) {
  auto *capture = new Capture;
  capture->pid = frontmostPid(); // Record before yielding or showing our window.
  napi_value promise, name;
  napi_create_promise(env, &capture->deferred, &promise);
  napi_create_string_utf8(env, "Capture selected text", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, execute, complete, capture, &capture->work) != napi_ok ||
      napi_queue_async_work(env, capture->work) != napi_ok) {
    if (capture->work) napi_delete_async_work(env, capture->work);
    delete capture;
    napi_throw_error(env, nullptr, "Could not start selection capture.");
    return nullptr;
  }
  return promise;
}

napi_value initialize(napi_env env, napi_value exports) {
  installShortcutExports(env, exports);
  napi_value function;
  napi_create_function(env, "captureSelection", NAPI_AUTO_LENGTH, captureSelection, nullptr, &function);
  napi_set_named_property(env, exports, "captureSelection", function);
  return exports;
}
}
NAPI_MODULE(cliptoboards_selection, initialize)
