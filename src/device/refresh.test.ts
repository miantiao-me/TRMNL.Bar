import { describe, expect, it } from "vite-plus/test";
import { Device } from "./controller.ts";
import { deferred, env, fixture, inputs } from "../testing/device.ts";
import { statusMessage } from "../ui/messages.ts";

describe("Device refresh and screen updates", () => {
  it("Keeps the previous screen and retries only the image download", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const first = f.device.image?.src;
    f.setDisplay({ status: 0, filename: "second", image_url: "second.bmp", refresh_rate: 60 });
    f.failImages(1);
    await f.device.scheduled(env("manual"));
    expect(f.device.phase).toBe("error");
    expect(f.device.image?.src).toBe(first);
    expect(f.count("/api/display")).toBe(2);
    f.advance(30_000);
    await f.device.scheduled(env());
    expect(f.count("/api/display")).toBe(2);
    expect(f.count("second.bmp")).toBe(2);
    expect(f.device.image?.src).not.toBe(first);
    expect(f.device.phase).toBe("ready");
    await f.device.scheduled(env());
    expect(f.count("/api/display")).toBe(2);
  });

  it("Uses the newly saved token when retrying the image download", async () => {
    const f = fixture();
    f.failImages(1);
    await f.device.scheduled(env("initial"));
    expect(f.device.lastFailure).toBe("image");
    f.secrets.set("access_token", "replacement-token");
    await f.device.scheduled(env("inputs-changed"));
    expect(f.count("/api/display")).toBe(1);
    expect(f.count("first.bmp")).toBe(2);
    const imageRequests = f.requests.filter((r) => r.url.pathname.endsWith("first.bmp"));
    expect(imageRequests.at(-1)?.init.headers).toHaveProperty("Access-Token", "replacement-token");
    expect(f.device.phase).toBe("ready");
    expect([...f.storage.values()].join("")).not.toContain("replacement-token");
  });

  it("Retries the pending image after CDN authorization and keeps the token on the server origin", async () => {
    const f = fixture();
    f.setDisplay({
      status: 0,
      filename: "cdn",
      image_url: "https://cdn.example/page.png",
      refresh_rate: 60,
    });
    await f.device.scheduled(env("initial"));
    expect(f.device.lastFailure).toBe("image-origin");
    expect(statusMessage(f.device.status)).toContain("https://cdn.example");
    expect(f.requests.some((r) => r.url.hostname === "cdn.example")).toBe(false);
    await f.device.scheduled({
      reason: "inputs-changed",
      inputs: { ...inputs, image_origin: "https://cdn.example" },
    });
    expect(f.device.image).toBeDefined();
    expect(f.count("/api/display")).toBe(1);
    expect(f.requests.find((r) => r.url.hostname === "cdn.example")?.init.headers).toEqual({});
  });

  it("Honors Retry-After and retries only the selected image", async () => {
    const f = fixture();
    const request = f.runtime.request;
    let limited = true;
    f.runtime.request = async (input, init) => {
      const response = await request(input, init);
      return limited &&
        (input instanceof Request ? input.url : input.toString()).endsWith("first.bmp")
        ? new Response(null, { status: 429, headers: { "Retry-After": "3600" } })
        : response;
    };
    await f.device.scheduled(env("initial"));
    expect(f.device.lastFailure).toBe("rate-limit");
    expect(f.scheduled.at(-1)).toBe(3_600_000);
    f.advance(30_000);
    await f.device.scheduled(env());
    expect(f.count("first.bmp")).toBe(1);
    expect(f.count("/api/display")).toBe(1);
    limited = false;
    f.advance(3_570_000);
    await f.device.scheduled(env());
    expect(f.device.phase).toBe("ready");
    expect(f.count("first.bmp")).toBe(2);
    expect(f.count("/api/display")).toBe(1);
  });

  it("Skips downloads for matching filenames or skip_update and fetches images without a filename", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const src = f.device.image?.src;
    await f.device.scheduled(env("manual"));
    expect(f.count("first.bmp")).toBe(1);
    f.setDisplay({ status: 0, skip_update: true, refresh_rate: 45 });
    await f.device.scheduled(env("manual"));
    expect(f.device.image?.src).toBe(src);
    expect(f.scheduled.at(-1)).toBe(45_000);
    f.setDisplay({ status: 0, image_url: "without-name.png", refresh_rate: 45 });
    await f.device.scheduled(env("manual"));
    await f.device.scheduled(env("manual"));
    expect(f.count("without-name.png")).toBe(2);
  });

  it("Keeps the displayed filename when skip_update returns an unseen filename", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    f.setDisplay({ status: 0, skip_update: true, filename: "second" });
    await f.device.scheduled(env("manual"));
    f.setDisplay({ status: 0, filename: "second", image_url: "second.png" });
    await f.device.scheduled(env("manual"));
    expect(f.count("second.png")).toBe(1);
  });

  it("Ignores oversized filenames for deduplication and preserves identity across restart", async () => {
    const f = fixture();
    f.setDisplay({ status: 0, filename: "x".repeat(17_000), image_url: "long.png" });
    await f.device.scheduled(env("initial"));
    f.runtime.makeId = () => "02:00:00:00:00:02";
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(restarted.id).toBe(f.device.id);
    expect(restarted.phase).toBe("ready");
    await restarted.scheduled(env("manual"));
    expect(f.count("long.png")).toBe(2);
  });

  it("Recovers on the next refresh after a response without an image URL", async () => {
    const f = fixture();
    f.setDisplay({ status: 0, refresh_rate: 60 });
    await f.device.scheduled(env("initial"));
    expect(f.device.lastFailure).toBe("response");
    f.setDisplay({ status: 0, image_url: "valid.bmp", filename: "valid" });
    await f.device.scheduled(env("manual"));
    expect(f.count("/api/display")).toBe(2);
    expect(f.device.phase).toBe("ready");
  });

  it("Retries at the scheduled retry time even when the previous screen has a later refresh deadline", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    f.setDisplay({}, 503);
    await f.device.scheduled(env("manual"));
    expect(f.device.phase).toBe("error");
    f.setDisplay({ status: 0, skip_update: true, refresh_rate: 60 });
    f.advance(30_000);
    await f.device.scheduled(env());
    expect(f.count("/api/display")).toBe(3);
    expect(f.device.phase).toBe("ready");
    expect(f.device.lastFailure).toBeUndefined();
    expect(statusMessage(f.device.status)).toBe("");
  });

  it("Splits a long refresh_rate into host wakeups within the 1-second to 24-hour range", async () => {
    const f = fixture();
    f.setDisplay({
      status: 0,
      image_url: "first.bmp",
      filename: "first",
      refresh_rate: 3 * 86_400,
    });
    await f.device.scheduled(env("initial"));
    expect(f.scheduled.at(-1)).toBe(86_400_000);
    f.advance(86_400_000);
    await f.device.scheduled(env());
    expect(f.count("/api/display")).toBe(1);
    expect(f.scheduled.at(-1)).toBe(86_400_000);
    f.device.refresh();
    expect(f.scheduled.at(-1)).toBe(1000);
  });

  it("Honors Retry-After longer than a day with an empty screen", async () => {
    const f = fixture();
    f.setDisplay({}, 429, { "Retry-After": "172800" });
    await f.device.scheduled(env("initial"));
    expect(f.device.lastFailure).toBe("rate-limit");
    f.advance(86_400_000);
    await f.device.scheduled(env());
    expect(f.count("/api/display")).toBe(1);
    expect(f.scheduled.at(-1)).toBe(86_400_000);
    f.advance(86_400_000);
    f.setDisplay({ status: 0, image_url: "ready.bmp", filename: "ready" });
    await f.device.scheduled(env());
    expect(f.count("/api/display")).toBe(2);
    expect(f.device.phase).toBe("ready");
  });

  it("Cancels old requests on refresh and keeps the newer successful screen when they finish late", async () => {
    const f = fixture();
    const request = f.runtime.request;
    let begin: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    f.runtime.request = async (input, init) => {
      if (typeof input !== "string" || !input.endsWith("/api/display")) return request(input, init);
      f.runtime.request = request;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        begin();
      });
    };
    const running = f.device.scheduled(env("initial"));
    await started;
    f.device.refresh();
    await running;
    expect(f.device.lastFailure).toBeUndefined();
    expect(f.scheduled.at(-1)).toBe(1000);
    await f.device.scheduled(env());
    expect(f.device.phase).toBe("ready");
    expect(f.device.image).toBeDefined();
  });

  it("Keeps the new server screen when an old image import finishes after cancellation", async () => {
    const f = fixture();
    const load = f.runtime.host.image.load.bind(f.runtime.host.image);
    const started = deferred();
    const finish = deferred();
    let delay = true;
    f.runtime.host.image.load = async (source) => {
      const image = await load(source);
      if (delay && typeof source !== "string") {
        delay = false;
        started.resolve();
        await finish.promise;
      }
      return image;
    };
    const old = f.device.scheduled(env("initial"));
    await started.promise;
    await f.device.scheduled(env("inputs-changed", { ...inputs, server: "https://next.example" }));
    const current = f.device.image?.src;
    finish.resolve();
    await old;
    expect(f.device.image?.src).toBe(current);
    expect(f.device.phase).toBe("ready");
  });
});
