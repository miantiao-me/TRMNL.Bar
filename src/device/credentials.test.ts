import { describe, expect, it, vi } from "vite-plus/test";
import { Device } from "./controller.ts";
import { deferred, env, fixture, inputs, mirrorFixture } from "../testing/device.ts";

describe("Device credentials and authentication", () => {
  it("Binds manually entered tokens and keeps them from other servers", async () => {
    const f = fixture();
    f.secrets.set("access_token", "manually-entered-token");
    await f.device.scheduled(env("initial"));
    expect(f.count("/api/setup")).toBe(0);
    const next = { ...inputs, server: "https://other.example/subpath/" };
    await f.device.scheduled(env("inputs-changed", next));
    const requests = f.requests.filter((r) => r.url.hostname === "other.example");
    expect(requests[0]?.url.pathname).toBe("/subpath/api/setup");
    expect(requests[0]?.init.headers).not.toHaveProperty("Access-Token");
    expect(requests[1]?.init.headers).toHaveProperty("Access-Token", "private-test-token");
    expect(JSON.stringify([...f.storage.values()])).not.toContain("manually-entered-token");
  });

  it("Keeps the screen on HTTP or JSON authentication failures and pairs again on reset_firmware", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const src = f.device.image?.src;
    f.setDisplay({}, 401);
    await f.device.scheduled(env("manual"));
    expect(f.device.lastFailure).toBe("authentication");
    expect(f.device.image?.src).toBe(src);
    expect(f.secrets.has("access_token")).toBe(true);
    f.setDisplay({ status: 500, reset_firmware: true });
    await f.device.scheduled(env("manual"));
    expect(f.secrets.has("access_token")).toBe(false);
    expect(f.device.image?.src).toBe(src);
    f.setDisplay({ status: 0, image_url: "first.bmp", filename: "first" });
    await f.device.scheduled(env("manual"));
    expect(f.count("/api/setup")).toBe(2);
  });

  it.each(["device", "mirror"])(
    "Keeps authentication paused in %s mode across default timer wakeups and restarts",
    async (mode) => {
      const f = mirrorFixture();
      const values = { ...inputs, mode };
      f.setMirror({ status: 401 }, 401);
      f.setDisplay({ status: 401 }, 401);
      await f.device.scheduled(env("initial", values));
      expect(f.device.lastFailure).toBe("authentication");
      const calls = f.requests.length;
      f.advance(7_200_000);
      await f.device.scheduled(env("interval", values));
      const restarted = new Device(f.runtime);
      await restarted.scheduled(env("initial", values));
      await restarted.scheduled(env("cache-missing", values));
      expect(restarted.lastFailure).toBe("authentication");
      expect(f.requests).toHaveLength(calls);
      f.secrets.set("access_token", "updated-device-key");
      f.setMirror({ status: 200, image_url: "images/current.bmp", filename: "current" });
      f.setDisplay({ status: 0, image_url: "images/first.bmp", filename: "first" });
      await restarted.scheduled(env("inputs-changed", values));
      expect(restarted.phase).toBe("ready");
      expect(f.requests.length).toBeGreaterThan(calls);
    },
  );

  it("Reports a storage error and keeps the screen when pairing cannot delete credentials", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const previous = f.device.image?.src;
    f.runtime.host.deleteSecret = async () => {
      throw new Error("keychain unavailable");
    };
    f.device.pairAgain();
    await f.device.scheduled(env());
    expect(f.device.lastFailure).toBe("credentials");
    expect(f.device.image?.src).toBe(previous);
  });

  it("Checks secure credential writes independently of browser authorization", async () => {
    const f = fixture();
    const caniuse = vi.fn(async (name: string) => name !== "setSecret");
    f.runtime.host.caniuse = caniuse;
    await f.device.scheduled(env("initial"));
    expect(f.device.lastFailure).toBe("unsupported");
    expect(f.requests).toHaveLength(0);
    expect(caniuse).toHaveBeenCalledWith("setSecret");
  });

  it("Times out a credential operation that ignores cancellation and allows the next refresh", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const finish = deferred();
    const setSecret = f.runtime.host.setSecret.bind(f.runtime.host);
    f.runtime.host.setSecret = async (name, value) => {
      await finish.promise;
      await setSecret(name, value);
    };
    let completed = false;
    const pending = f.device.scheduled(env("initial")).then(() => {
      completed = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(12_001);
      expect(completed).toBe(true);
      expect(f.device.lastFailure).toBe("timeout");
    } finally {
      finish.resolve();
      await pending;
      vi.useRealTimers();
    }
    f.runtime.host.setSecret = setSecret;
    await f.device.scheduled(env("manual"));
    expect(f.device.phase).toBe("ready");
    expect(f.device.image).toBeDefined();
  });

  it("Waits for in-flight credential writes before switching servers to protect the new binding", async () => {
    const f = fixture();
    const started = deferred();
    const finish = deferred();
    let first = true;
    f.runtime.host.setSecret = async (name, value) => {
      if (first) {
        first = false;
        started.resolve();
        await finish.promise;
      }
      f.secrets.set(name, value);
    };
    const old = f.device.scheduled(env("initial"));
    await started.promise;
    const next = f.device.scheduled(
      env("inputs-changed", { ...inputs, server: "https://other.example/" }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    finish.resolve();
    await Promise.all([old, next]);
    expect(f.secrets.get("access_token")).toContain("https://other.example/");
    expect(f.device.phase).toBe("ready");
  });
});
