import { describe, expect, it, vi } from "vite-plus/test";
import { Device } from "./controller.ts";
import { stateKey } from "../storage/state.ts";
import { deferred, env, fixture, inputs } from "../testing/device.ts";

describe("Device enrollment and identity", () => {
  it("Pairs automatically through setup, stores the token securely, and refreshes at the server interval in seconds", async () => {
    const f = fixture();
    const write = vi.spyOn(f.runtime.host, "setSecret");
    await f.device.scheduled(env("initial"));
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.count("/api/setup")).toBe(1);
    expect(f.count("/api/display")).toBe(1);
    expect(f.device.phase).toBe("ready");
    expect(f.device.image?.format).toBe("png");
    expect(f.device.id).toBe("02:11:22:33:44:55");
    expect(f.scheduled.at(-1)).toBe(61_000);
    expect(f.secrets.get("access_token")).toContain("private-test-token");
    expect([...f.storage.values()].join("")).not.toContain("private-test-token");
    expect(f.requests.find((r) => r.url.pathname.endsWith("display"))?.init.headers).toHaveProperty(
      "Access-Token",
      "private-test-token",
    );
  });

  it("Shows the enrollment screen and uses the same device ID on the next request", async () => {
    const f = fixture();
    f.setSetup({ status: 202, friendly_id: "REGISTER", image_url: "pair.bmp", refresh_rate: 15 });
    await f.device.scheduled(env("initial"));
    expect(f.device.phase).toBe("pairing");
    expect(f.device.friendlyId).toBe("REGISTER");
    expect(f.device.image).toBeDefined();
    expect(f.count("/api/display")).toBe(0);
    expect(f.scheduled.at(-1)).toBe(15_000);
    f.advance(15_000);
    f.setSetup({ status: 200, api_key: "now-paired" });
    await f.device.scheduled(env());
    expect(f.count("/api/setup")).toBe(2);
    expect(f.device.phase).toBe("ready");
    expect(
      f.requests
        .filter((r) => r.url.pathname.endsWith("setup"))
        .map((r) => (r.init.headers as Record<string, string>).ID),
    ).toEqual(["02:11:22:33:44:55", "02:11:22:33:44:55"]);
  });

  it("Retains the pairing state and device ID after restarting during enrollment", async () => {
    const f = fixture();
    f.setSetup({ status: 202, friendly_id: "WAIT", image_url: "pair.bmp", refresh_rate: 60 });
    await f.device.scheduled(env("initial"));
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(restarted.phase).toBe("pairing");
    expect(restarted.friendlyId).toBe("WAIT");
    expect(f.count("/api/setup")).toBe(1);
  });

  it("Splits a long server wait into multiple wakeups while enrollment has no image", async () => {
    const f = fixture();
    f.setSetup({ status: 202, refresh_rate: 172800 });
    await f.device.scheduled(env("initial"));
    expect(f.device.phase).toBe("pairing");
    expect(f.scheduled.at(-1)).toBe(86_400_000);
    f.advance(86_400_000);
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(f.count("/api/setup")).toBe(1);
    expect(f.scheduled.at(-1)).toBe(86_400_000);
    f.advance(86_400_000);
    await restarted.scheduled(env());
    expect(f.count("/api/setup")).toBe(2);
  });

  it("Reuses a one-time setup token when a new scheduled run supersedes the first", async () => {
    const f = fixture();
    const request = f.runtime.request;
    const started = deferred();
    const finish = deferred();
    f.runtime.request = async (input, init) => {
      const response = await request(input, init);
      if (typeof input !== "string" || !input.endsWith("/api/setup")) return response;
      if (f.count("/api/setup") > 1) return new Response(JSON.stringify({ status: 200 }));
      started.resolve();
      await finish.promise;
      init?.signal?.throwIfAborted();
      return response;
    };
    const initial = f.device.scheduled(env("initial"));
    await started.promise;
    const resumed = f.device.scheduled(env("initial"));
    await initial;
    finish.resolve();
    await resumed;
    expect(f.count("/api/setup")).toBe(1);
    expect(f.device.phase).toBe("ready");
    expect(
      f.requests.find((r) => r.url.pathname.endsWith("/api/display"))?.init.headers,
    ).toHaveProperty("Access-Token", "private-test-token");
  });

  it("Keeps the enrolled device ID and credentials when restarting after an interrupted first display request", async () => {
    const f = fixture();
    const originalId = f.device.id;
    f.runtime.makeId = () => "02:00:00:00:00:02";
    const request = f.runtime.request;
    const started = deferred();
    const finish = deferred();
    f.runtime.request = async (input, init) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith("/api/display")) {
        started.resolve();
        await finish.promise;
      }
      return request(input, init);
    };
    const running = f.device.scheduled(env("initial"));
    await started.promise;
    f.device.refresh();
    await running;
    finish.resolve();
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(restarted.id).toBe(originalId);
    expect(f.count("/api/setup")).toBe(1);
    expect(restarted.phase).toBe("ready");
  });

  it("Migrates a legacy X device to 800 × 480 and keeps its paired identity", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const oldImage = f.device.image?.src;
    const persisted = JSON.parse(f.storage.get(stateKey)!);
    f.storage.set(stateKey, JSON.stringify({ ...persisted, model: "x" }));
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial", { ...inputs, model: "x" }));
    expect(f.count("/api/setup")).toBe(1);
    expect(restarted.id).toBe(f.device.id);
    expect(restarted.image?.src).toBeDefined();
    expect(restarted.image?.src).not.toBe(oldImage);
    expect(
      f.requests.filter(({ url }) => url.pathname.endsWith("/api/display")).at(-1)?.init.headers,
    ).toMatchObject({
      Model: "og",
      Width: "800",
      Height: "480",
      "Access-Token": "private-test-token",
    });
  });

  it("Shows the enrollment image while pairing again despite an old filename or skip_update", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const previous = f.device.image?.src;
    f.setDisplay({
      status: 202,
      filename: "first",
      image_url: "registration.png",
      skip_update: true,
      refresh_rate: 30,
    });
    await f.device.scheduled(env("manual"));
    expect(f.device.phase).toBe("pairing");
    expect(f.device.image?.src).not.toBe(previous);
    expect(f.count("registration.png")).toBe(1);
    expect(f.scheduled.at(-1)).toBe(30_000);
  });
});
