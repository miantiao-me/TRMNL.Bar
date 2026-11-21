import assert from "node:assert/strict";
import { run } from "../system.ts";
import type { Application } from "./native.ts";

export const testTrayTitle = "TRMNL";

const clickMenuItem = String.raw`import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

func find(_ element: AXUIElement, title: String, depth: Int) -> AXUIElement? {
    if attribute(element, kAXTitleAttribute) as? String == title { return element }
    if depth == 0 { return nil }
    for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        if let match = find(child, title: title, depth: depth - 1) { return match }
    }
    return nil
}

func waitFor(_ lookup: () -> AXUIElement?) -> AXUIElement? {
    let deadline = Date().addingTimeInterval(3)
    repeat {
        if let result = lookup() { return result }
        Thread.sleep(forTimeInterval: 0.05)
    } while Date() < deadline
    return nil
}

func click(_ element: AXUIElement, button: CGMouseButton, down: CGEventType, up: CGEventType) {
    guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute) else {
        fail("Cannot locate the menu item on screen")
    }
    var point = CGPoint.zero
    var bounds = CGSize.zero
    AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point)
    AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &bounds)
    point.x += bounds.width / 2
    point.y += bounds.height / 2
    CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.08)
    CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments
let app = AXUIElementCreateApplication(pid_t(args[1])!)
guard AXIsProcessTrusted() else { fail("Accessibility permission is required to verify the native menu") }
guard let tray = waitFor({
    guard let bar = attribute(app, kAXExtrasMenuBarAttribute) else { return nil }
    return find(unsafeBitCast(bar, to: AXUIElement.self), title: args[2], depth: 1)
}) else { fail("Menu bar item not found: \(args[2])") }
click(tray, button: .right, down: .rightMouseDown, up: .rightMouseUp)
guard let item = waitFor({ find(tray, title: args[3], depth: 3) ?? find(app, title: args[3], depth: 6) }) else {
    CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)?.post(tap: .cghidEventTap)
    fail("Right-click action not found: \(args[3])")
}
if AXUIElementPerformAction(item, kAXPressAction as CFString) != .success {
    click(item, button: .left, down: .leftMouseDown, up: .leftMouseUp)
}`;

export async function pressTray({ process }: Application, label: string): Promise<void> {
  assert(process.pid);
  await run("/usr/bin/swift", ["-e", clickMenuItem, String(process.pid), testTrayTitle, label], {
    timeout: 15_000,
  });
}
