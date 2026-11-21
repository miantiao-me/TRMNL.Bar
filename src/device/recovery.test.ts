import { describe, expect, it } from "vite-plus/test";
import { Device } from "./controller.ts";
import { stateKey, type Credential, type State } from "../storage/state.ts";
import { env, fixture } from "../testing/device.ts";

describe("Screen caching and recovery", () => {
  it("Reuses the persisted image after restart and recovers a missing cache with the same device ID", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const first = f.device.image?.src;
    const afterRestart = new Device(f.runtime);
    await afterRestart.scheduled(env("initial"));
    expect(afterRestart.image?.src).toBe(first);
    expect(f.count("/api/display")).toBe(1);
    expect(afterRestart.id).toBe(f.device.id);
    f.images.clear();
    const recovered = new Device(f.runtime);
    await recovered.scheduled(env("initial"));
    expect(recovered.image?.src).not.toBe(first);
    expect(f.count("/api/display")).toBe(1);
    expect(f.count("first.bmp")).toBe(2);
    expect(recovered.id).toBe(f.device.id);
  });

  it("Recovers the screen immediately when the legacy image cache and checkpoint are missing", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const state = JSON.parse(f.storage.get(stateKey)!) as State;
    const credential = JSON.parse(f.secrets.get("access_token")!) as Credential;
    delete state.image;
    delete credential.key;
    f.storage.set(stateKey, JSON.stringify(state));
    f.secrets.set("access_token", JSON.stringify(credential));
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(f.count("/api/display")).toBe(2);
    expect(restarted.image).toBeDefined();
    expect(restarted.phase).toBe("ready");
  });

  it("Resumes unfinished downloads after restart and stores signed URLs encrypted", async () => {
    const f = fixture();
    f.runtime.host.setSecret = async (name, value) => {
      if (new TextEncoder().encode(value).length > 2560) throw new Error("secret size limit");
      f.secrets.set(name, value);
    };
    await f.device.scheduled(env("initial"));
    const first = f.device.image?.src;
    const signature = `private-signature-${"x".repeat(4000)}`;
    f.setDisplay({
      status: 0,
      image_url: `second.bmp?signature=${signature}`,
      filename: "second",
      refresh_rate: 60,
    });
    f.failImages(1);
    await f.device.scheduled(env("manual"));
    expect(f.device.image?.src).toBe(first);
    expect([...f.storage.values()].join("")).not.toContain(signature);
    expect([...f.storage.values()].join("")).not.toContain("private-test-token");
    f.advance(30_000);
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(f.count("/api/display")).toBe(2);
    expect(f.count("second.bmp")).toBe(2);
    expect(restarted.image?.src).not.toBe(first);
    expect(restarted.phase).toBe("ready");
  });

  it("Keeps the refresh deadline from skip_update during cache recovery", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    f.advance(61_000);
    f.setDisplay({ status: 0, skip_update: true, refresh_rate: 3600 });
    await f.device.scheduled(env());
    const nextPollAt = (JSON.parse(f.storage.get(stateKey)!) as State).nextPollAt;
    f.images.clear();
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect((JSON.parse(f.storage.get(stateKey)!) as State).nextPollAt).toBe(nextPollAt);
    expect(f.scheduled.at(-1)).toBe(3_600_000);
    await restarted.scheduled(env());
    expect(f.count("/api/display")).toBe(2);
  });

  it("Keeps a newer image-free enrollment state during cache recovery", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    f.setDisplay({ status: 202, friendly_id: "REGISTER", refresh_rate: 300 });
    await f.device.scheduled(env("manual"));
    f.images.clear();
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(restarted.phase).toBe("pairing");
    expect(restarted.friendlyId).toBe("REGISTER");
    expect(f.scheduled.at(-1)).toBe(300_000);
    expect((JSON.parse(f.storage.get(stateKey)!) as State).filename).toBe("first");
    f.setDisplay({ status: 0, filename: "first", image_url: "first.bmp" });
    await restarted.scheduled(env("manual"));
    expect(restarted.phase).toBe("ready");
    expect(f.count("first.bmp")).toBe(2);
  });

  it("Rechecks an already verified image reference on cache-missing", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    f.images.clear();
    await f.device.scheduled(env("cache-missing"));
    expect(f.images.has(f.device.image!.src)).toBe(true);
    expect(f.count("first.bmp")).toBe(2);
    expect(f.count("/api/display")).toBe(1);
  });

  it("Discards a corrupt encrypted checkpoint and fetches a new screen", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const key = "trmnl:frame:v1";
    f.storage.set(
      key,
      f.storage
        .get(key)!
        .replace(
          /("data":")([a-f0-9])/,
          (_match: string, prefix: string, digit: string) => prefix + (digit === "0" ? "1" : "0"),
        ),
    );
    f.images.clear();
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(f.count("/api/display")).toBe(2);
    expect(restarted.phase).toBe("ready");
  });
});
