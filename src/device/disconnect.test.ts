import { describe, expect, it, vi } from "vite-plus/test";
import { frameKey } from "../storage/checkpoint.ts";
import { Device } from "./controller.ts";
import { stateKey } from "../storage/state.ts";
import { deferred, env, fixture, inputs, mirrorFixture, mirrorInputs } from "../testing/device.ts";

describe("Disconnecting and reconnecting", () => {
  it("Clears credentials, the checkpoint, and the screen and stays disconnected until explicitly reconnected", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const id = f.device.id;
    expect(f.storage.has(frameKey)).toBe(true);
    f.device.disconnect();
    expect(f.device.image).toBeUndefined();
    await f.device.scheduled(env("interval"));
    expect(f.device.phase).toBe("disconnected");
    expect(f.secrets.size).toBe(0);
    expect(f.storage.has(frameKey)).toBe(false);
    expect(f.scheduled.at(-1)).toBeNull();
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(restarted.phase).toBe("disconnected");
    expect(f.count("/api/setup")).toBe(1);
    restarted.connect();
    await restarted.scheduled(env("interval"));
    expect(restarted.phase).toBe("ready");
    expect(restarted.id).toBe(id);
    expect(f.count("/api/setup")).toBe(2);
    expect(JSON.parse(f.storage.get(stateKey)!).connection).toBe("connected");
  });

  it("Keeps requests paused after credential deletion fails and clears the cache after a successful retry", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const remove = f.runtime.host.deleteSecret.bind(f.runtime.host);
    f.runtime.host.deleteSecret = async () => {
      throw new Error("storage unavailable");
    };
    f.device.disconnect();
    await f.device.scheduled(env("interval"));
    expect(f.device.lastFailure).toBe("credentials");
    expect(f.device.disconnected).toBe(true);
    expect(f.device.image).toBeUndefined();
    expect(f.count("/api/display")).toBe(1);
    expect(f.storage.has(frameKey)).toBe(true);
    f.runtime.host.deleteSecret = remove;
    await f.device.scheduled(env("manual"));
    expect(f.device.phase).toBe("disconnected");
    expect(f.storage.has(frameKey)).toBe(false);
  });

  it("Keeps a new token after disconnect and restart even if an old menu action runs", async () => {
    const f = fixture();
    f.secrets.set("access_token", "original-key");
    await f.device.scheduled(env("initial", mirrorInputs));
    f.device.disconnect();
    await f.device.scheduled(env("interval", mirrorInputs));
    const remove = vi.spyOn(f.runtime.host, "deleteSecret");
    f.secrets.set("access_token", "new-mirror-key");
    f.device.disconnect();
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial", mirrorInputs));
    expect(f.secrets.get("access_token")).toBe("new-mirror-key");
    expect(remove).not.toHaveBeenCalled();
    expect(f.count("/api/display/current")).toBe(1);
    restarted.connect();
    await restarted.scheduled(env("interval", mirrorInputs));
    expect(restarted.phase).toBe("ready");
    expect(
      f.requests.filter(({ url }) => url.pathname.endsWith("/api/display/current")).at(-1)?.init
        .headers,
    ).toHaveProperty("Access-Token", "new-mirror-key");
  });

  it("Resumes credential cleanup from legacy disconnect state after restart", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const state = JSON.parse(f.storage.get(stateKey)!);
    delete state.connection;
    f.storage.set(stateKey, JSON.stringify({ ...state, disconnected: true }));
    const restarted = new Device(f.runtime);
    expect(restarted.phase).toBe("disconnecting");
    await restarted.scheduled(env("initial"));
    expect(restarted.phase).toBe("disconnected");
    expect(f.secrets.size).toBe(0);
    expect(f.storage.has(frameKey)).toBe(false);
    expect(f.count("/api/setup")).toBe(1);
  });

  it("Disconnect takes precedence over a queued pairing request", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    f.device.pairAgain();
    f.device.disconnect();
    await f.device.scheduled(env("interval"));
    expect(f.device.phase).toBe("disconnected");
    expect(f.count("/api/setup")).toBe(1);
  });

  it.each([{ server: "https://new.example/prefix" }, { device_id: "02:AA:BB:CC:DD:EE" }])(
    "Requires an explicit connection after changing settings to %j while disconnected",
    async (changed) => {
      const f = fixture();
      await f.device.scheduled(env("initial"));
      f.device.disconnect();
      await f.device.scheduled(env("interval"));
      const calls = f.requests.length;
      const values = { ...inputs, ...changed };
      await f.device.scheduled(env("inputs-changed", values));
      expect(f.device.phase).toBe("disconnected");
      expect(f.requests).toHaveLength(calls);
      f.device.connect();
      await f.device.scheduled(env("interval", values));
      expect(f.device.phase).toBe("ready");
      expect(f.requests.length).toBeGreaterThan(calls);
    },
  );

  it.each([{ server: "invalid" }, { device_id: "invalid\nID" }, { mirror_refresh: "invalid" }])(
    "Completes disconnect cleanup with invalid settings %j",
    async (changed) => {
      const f = fixture();
      await f.device.scheduled(env("initial"));
      f.device.disconnect();
      await f.device.scheduled(env("inputs-changed", { ...inputs, ...changed }));
      expect(f.device.phase).toBe("disconnected");
      expect(f.secrets.size).toBe(0);
      expect(f.storage.has(frameKey)).toBe(false);
      expect(f.count("/api/setup")).toBe(1);
    },
  );

  it("Cancels in-flight setup on disconnect and discards a late token", async () => {
    const f = fixture();
    const request = f.runtime.request;
    const started = deferred();
    const finish = deferred();
    let signal: AbortSignal | null | undefined;
    f.runtime.request = async (input, init) => {
      const response = await request(input, init);
      if (typeof input !== "string" || !input.endsWith("/api/setup")) return response;
      signal = init?.signal;
      started.resolve();
      await finish.promise;
      return response;
    };
    const initial = f.device.scheduled(env("initial"));
    await started.promise;
    f.device.disconnect();
    await f.device.scheduled(env());
    finish.resolve();
    await initial;
    expect(signal?.aborted).toBe(true);
    expect(f.secrets.size).toBe(0);
    expect(f.count("/api/display")).toBe(0);
    expect(f.device.phase).toBe("disconnected");
  });

  it("Cancels in-flight diagnostics immediately on disconnect", async () => {
    const f = fixture();
    f.failImages(1);
    await f.device.scheduled(env("initial"));
    const request = f.runtime.request;
    const started = deferred();
    let signal: AbortSignal | null | undefined;
    f.runtime.request = async (input, init) => {
      if (typeof input !== "string" || !input.endsWith("/api/log")) return request(input, init);
      signal = init?.signal;
      started.resolve();
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new DOMException("cancelled", "AbortError");
    };
    const pending = f.device.sendLog();
    await started.promise;
    f.device.disconnect();
    expect(signal?.aborted).toBe(true);
    await f.device.scheduled(env("interval"));
    await pending;
    expect(f.device.phase).toBe("disconnected");
    expect(f.count("/api/log")).toBe(0);
  });

  it("Discards late images on disconnect and keeps the screen cleared after restart", async () => {
    const f = mirrorFixture();
    await f.device.scheduled(env("initial", mirrorInputs));
    const started = deferred();
    const finish = deferred();
    const load = f.runtime.host.image.load.bind(f.runtime.host.image);
    f.runtime.host.image.load = async (source) => {
      if (typeof source !== "string") {
        started.resolve();
        await finish.promise;
      }
      return load(source);
    };
    f.setMirror({ status: 200, image_url: "late.bmp", filename: "late" });
    const pending = f.device.scheduled(env("manual", mirrorInputs));
    await started.promise;
    f.device.disconnect();
    await f.device.scheduled(env("interval", mirrorInputs));
    finish.resolve();
    await pending;
    expect(f.device.phase).toBe("disconnected");
    expect(f.device.image).toBeUndefined();
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial", mirrorInputs));
    expect(restarted.image).toBeUndefined();
    expect(f.count("/api/display/current")).toBe(2);
  });
});
