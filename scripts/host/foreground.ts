import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NativeHost, type Application } from "./native.ts";
import { root, run, waitFor, writeJSON } from "../system.ts";

export const foregroundArtifacts = join(root, "dist/foreground-verification");

const sessionScript = `import AppKit
import CoreGraphics
import Foundation
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
var result: [String: Any] = [
    "locked": session["CGSSessionScreenIsLocked"] as? Bool ?? false,
    "on_console": session[kCGSessionOnConsoleKey as String] as? Bool ?? false
]
if CommandLine.arguments.count > 1, let pid = Int32(CommandLine.arguments[1]) {
    if CommandLine.arguments.count > 2 {
        result["activated"] = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) ?? false
    }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    if let window = windows.first(where: {
        ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
    }) {
        result["window_id"] = window[kCGWindowNumber as String]
    }
}
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)`;

interface Session {
  locked: boolean;
  on_console: boolean;
  activated?: boolean;
  window_id?: number;
}

async function session(pid?: number, activate = false): Promise<Session> {
  const args = ["-e", sessionScript];
  if (pid !== undefined) args.push(String(pid));
  if (activate) args.push("activate");
  const { stdout } = await run("/usr/bin/swift", args, { timeout: 15_000 });
  return JSON.parse(stdout) as Session;
}

export async function unlockedDesktop(): Promise<Session> {
  const desktop = await session();
  assert(!desktop.locked && desktop.on_console, "Unlock the desktop before running verification");
  return desktop;
}

export function configureDrawing(software = false): void {
  delete process.env.MYGO_GPU;
  delete process.env.MYGO_PARTIAL;
  delete process.env.MYGO_UNCAPPED;
  if (software) process.env.MYGO_GPU = "0";
  process.env.MYGO_FRAME_STATS = "all";
}

export class ForegroundHost extends NativeHost {
  constructor(artifacts = foregroundArtifacts, identifier?: string) {
    super(artifacts, identifier);
  }

  override async application<T>(
    stage: string,
    action: (app: Application) => Promise<T>,
    locale = "en",
  ): Promise<T> {
    return super.application(
      stage,
      async (app) => {
        const { client, process } = app;
        await waitFor(
          async () =>
            (await client.call("windows")).windows.some(
              (window) => window.visible && window.kind === "content",
            ),
          "a visible window",
          process,
        );
        assert(process.pid);
        const desktop = await session(process.pid, true);
        assert(!desktop.locked && desktop.on_console && desktop.activated, JSON.stringify(desktop));
        await waitFor(
          async () => (await client.call("windows")).windows.some((window) => window.focused),
          "a focused window",
          process,
        );
        return action(app);
      },
      locale,
    );
  }

  override async capture(
    { client, process }: Application,
    window: number,
    name: string,
  ): Promise<void> {
    const focused = async () =>
      (await client.call("windows")).windows.some((item) => item.id === window && item.focused);
    assert(process.pid);
    const desktop = await session(process.pid, !(await focused()));
    assert(!desktop.locked && desktop.on_console && desktop.window_id, JSON.stringify(desktop));
    await client.call("idle", { window, timeout: 5000 });
    assert(await focused(), `The window lost focus before capture (${name})`);
    await run(
      "/usr/sbin/screencapture",
      ["-x", "-o", "-l", String(desktop.window_id), join(this.artifacts, `${name}.png`)],
      { timeout: 10_000 },
    );
    writeJSON(join(this.artifacts, `${name}-tree.json`), await client.tree(window));
  }
}

export function gpuFrames(artifacts: string, stage: string): number {
  const log = readFileSync(join(artifacts, `${stage}.log`), "utf8");
  const frames = [...log.matchAll(/\(drawn on the GPU/g)].length;
  assert(
    frames > 0 && !/drawing without the GPU|drawing in software/.test(log),
    `Expected GPU-only drawing in ${stage}`,
  );
  return frames;
}
