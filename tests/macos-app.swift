// Observe the app through macOS without attaching a debugger or reading its UI.
import AppKit
import CoreGraphics
import Foundation

let identifier = CommandLine.arguments[1]
let action = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "inspect"
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)

switch action {
case "quit":
    for app in apps { _ = app.terminate() }
default:
    break
}

let windows = CGWindowListCopyWindowInfo(
    [.optionAll, .excludeDesktopElements], kCGNullWindowID
) as? [[String: Any]] ?? []

let state: [[String: Any]] = apps.filter { !$0.isTerminated }.map { app in
    let appWindows = windows.filter {
        ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier
            && ($0[kCGWindowLayer as String] as? Int) == 0
    }.map { window in
        [
            "onscreen": window[kCGWindowIsOnscreen as String] ?? false,
            "bounds": window[kCGWindowBounds as String] ?? [:],
        ]
    }
    return [
        "pid": app.processIdentifier,
        "active": app.isActive,
        "hidden": app.isHidden,
        "dockIconVisible": app.activationPolicy == .regular,
        "windows": appWindows,
    ]
}
let output = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
print(String(decoding: output, as: UTF8.self))
