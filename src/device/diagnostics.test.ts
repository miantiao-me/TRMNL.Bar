import { describe, expect, it } from "vite-plus/test";
import { env, fixture } from "../testing/device.ts";
import { statusMessage } from "../ui/messages.ts";

describe("Device diagnostics", () => {
  it("Skips network requests when capabilities are missing and sends limited static data on request", async () => {
    const f = fixture();
    f.setAvailable(false);
    await f.device.scheduled(env("initial"));
    expect(f.device.lastFailure).toBe("unsupported");
    expect(f.requests).toHaveLength(0);
    expect(f.scheduled).toHaveLength(0);
    f.setAvailable(true);
    f.failImages(1);
    await f.device.scheduled(env("manual"));
    await f.device.sendLog();
    const log = f.requests.find((r) => r.url.pathname.endsWith("/api/log"));
    expect(log?.init.method).toBe("POST");
    const body = typeof log?.init.body === "string" ? log.init.body : "";
    expect(body).toContain("virtual-device:image");
    expect(body).not.toContain("private-test-token");
    expect(body).not.toContain("https://");
  });

  it("Reports missing pairing credentials alongside the original error", async () => {
    const f = fixture();
    f.failImages(1);
    await f.device.scheduled(env("initial"));
    await f.device.sendLog();
    expect(f.device.lastFailure).toBe("image");
    expect(statusMessage(f.device.status)).toContain("Unable to load screen");
    expect(statusMessage(f.device.status)).toContain("Diagnostics sent");
    const unpaired = fixture();
    unpaired.setSetup({ status: 500 });
    await unpaired.device.scheduled(env("initial"));
    await unpaired.device.sendLog();
    expect(unpaired.device.lastFailure).toBe("response");
    expect(statusMessage(unpaired.device.status)).toContain("Pair the device to send diagnostics");
    expect(unpaired.count("/api/log")).toBe(0);
  });
});
