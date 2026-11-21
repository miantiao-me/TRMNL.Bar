import { describe, expect, it } from "vite-plus/test";
import { configuration } from "../config.ts";
import { Device } from "./controller.ts";
import { env, fixture, mirrorFixture, mirrorInputs } from "../testing/device.ts";
import { statusMessage } from "../ui/messages.ts";

describe("Mirroring the current screen", () => {
  it("Reads only the current screen at the configured interval", async () => {
    const f = mirrorFixture();
    await f.device.scheduled(env("initial", mirrorInputs));
    expect(f.device.phase).toBe("ready");
    expect(f.count("/prefix/api/display/current")).toBe(1);
    expect(f.count("/api/setup")).toBe(0);
    expect(f.count("/api/display")).toBe(0);
    expect(f.requests[0]?.init.headers).toEqual({
      "Access-Token": "mirror-device-key",
      Accept: "application/json",
    });
    expect(f.scheduled.at(-1)).toBe(300_000);
    const first = f.device.image?.src;
    f.advance(61_000);
    await f.device.scheduled(env("interval", mirrorInputs));
    expect(f.count("/api/display/current")).toBe(1);
    f.advance(239_000);
    await f.device.scheduled(env("interval", mirrorInputs));
    expect(f.count("/api/display/current")).toBe(2);
    expect(f.device.image?.src).toBe(first);
    expect(f.count("current.bmp")).toBe(1);
  });

  it("Reads the LaraPaper current screen when the standard mirror route is missing", async () => {
    const f = mirrorFixture();
    const request = f.runtime.request;
    f.setMirror({ message: "The route prefix/api/display/current could not be found." }, 404);
    f.runtime.request = async (input, init) => {
      if (typeof input === "string" && input.endsWith("/api/current_screen")) {
        expect(new URL(input).pathname).toBe("/prefix/api/current_screen");
        expect(init?.method).toBe("GET");
        expect(init?.headers).toEqual({
          "Access-Token": "mirror-device-key",
          Accept: "application/json",
        });
        return Response.json({ status: 200, image_url: "images/larapaper.bmp" });
      }
      return request(input, init);
    };
    await f.device.scheduled(env("initial", mirrorInputs));
    expect(f.device.phase).toBe("ready");
    expect(f.device.image).toBeDefined();
    expect(f.count("/api/display/current")).toBe(1);
    expect(f.count("larapaper.bmp")).toBe(1);
    expect(f.count("/api/display")).toBe(0);
    expect(f.count("/api/setup")).toBe(0);
    expect(f.scheduled.at(-1)).toBe(300_000);
  });

  it("Prompts for a missing device token and waits for configuration", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial", mirrorInputs));
    expect(f.device.phase).toBe("unconfigured");
    expect(statusMessage(f.device.status)).toBe("Enter a device token");
    expect(f.requests).toHaveLength(0);
    expect(f.scheduled.at(-1)).toBeNull();
    f.secrets.set("access_token", "mirror-device-key");
    await f.device.scheduled(env("inputs-changed", mirrorInputs));
    expect(f.device.phase).toBe("ready");
    expect(f.count("/api/setup")).toBe(0);
  });

  it.each([200, 404])(
    "Keeps the previous screen and continues polling on an HTTP %i response without a screen",
    async (http) => {
      const f = mirrorFixture();
      await f.device.scheduled(env("initial", mirrorInputs));
      const first = f.device.image?.src;
      f.setMirror({ status: 404 }, http);
      await f.device.scheduled(env("manual", mirrorInputs));
      expect(f.device.phase).toBe("empty");
      expect(f.device.lastFailure).toBeUndefined();
      expect(f.device.image?.src).toBe(first);
      expect(f.scheduled.at(-1)).toBe(300_000);
      const restarted = new Device(f.runtime);
      await restarted.scheduled(env("initial", mirrorInputs));
      expect(restarted.phase).toBe("empty");
      expect(f.count("/api/display/current")).toBe(2);
      expect(f.count("/api/display")).toBe(0);
    },
  );

  it("Shows the empty-screen state on mirror 202", async () => {
    const f = mirrorFixture();
    f.setMirror({ status: 202 });
    await f.device.scheduled(env("initial", mirrorInputs));
    expect(f.device.phase).toBe("empty");
    expect(f.count("/api/setup")).toBe(0);
    expect(f.scheduled.at(-1)).toBe(300_000);
  });

  it("Keeps the empty mirror state when its image cache is lost", async () => {
    const f = mirrorFixture();
    await f.device.scheduled(env("initial", mirrorInputs));
    f.setMirror({ status: 404 });
    await f.device.scheduled(env("manual", mirrorInputs));
    f.images.clear();
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("cache-missing", mirrorInputs));
    expect(restarted.phase).toBe("empty");
    expect(restarted.image).toBeDefined();
    expect(f.count("/api/setup")).toBe(0);
    expect(f.count("/api/display/current")).toBe(2);
    expect(f.scheduled.at(-1)).toBe(300_000);
  });

  it("Treats an empty HTTP 202 response as a pending screen", async () => {
    const f = mirrorFixture();
    const request = f.runtime.request;
    f.runtime.request = async (input, init) =>
      typeof input === "string" && input.endsWith("/api/display/current")
        ? new Response(null, { status: 202 })
        : request(input, init);
    await f.device.scheduled(env("initial", mirrorInputs));
    expect(f.device.phase).toBe("empty");
    expect(f.device.lastFailure).toBeUndefined();
    expect(f.scheduled.at(-1)).toBe(300_000);
  });

  it("Ignores physical device reset and firmware update flags in mirror mode", async () => {
    const f = mirrorFixture();
    f.setMirror({
      status: 200,
      image_url: "images/current.bmp",
      filename: "current",
      reset_firmware: true,
      update_firmware: true,
    });
    await f.device.scheduled(env("initial", mirrorInputs));
    expect(f.device.phase).toBe("ready");
    expect(statusMessage(f.device.status)).toBe("");
    expect(f.device.image).toBeDefined();
    expect(f.secrets.has("access_token")).toBe(true);
    expect(f.count("/api/setup")).toBe(0);
  });

  it("Rejects the device success code in mirror mode and keeps using the current-screen endpoint", async () => {
    const f = mirrorFixture();
    f.setMirror({ status: 0, image_url: "wrong.bmp" });
    await f.device.scheduled(env("initial", mirrorInputs));
    expect(f.device.lastFailure).toBe("response");
    expect(f.count("/api/display")).toBe(0);
    await f.device.sendLog();
    f.device.pairAgain();
    expect(f.count("/api/log")).toBe(0);
    expect(f.count("/api/setup")).toBe(0);
  });

  it("Pauses polling on an invalid token and resumes mirroring after a token update", async () => {
    const f = mirrorFixture();
    f.setMirror({ status: 401 }, 401);
    await f.device.scheduled(env("initial", mirrorInputs));
    expect(f.device.lastFailure).toBe("authentication");
    expect(f.scheduled.at(-1)).toBeNull();
    f.secrets.set("access_token", "replacement-device-key");
    f.setMirror({ status: 200, image_url: "recovered.bmp", filename: "recovered" });
    await f.device.scheduled(env("inputs-changed", mirrorInputs));
    expect(f.device.phase).toBe("ready");
    expect(f.requests.at(-2)?.init.headers).toEqual({
      "Access-Token": "replacement-device-key",
      Accept: "application/json",
    });
  });

  it("Keeps the token across mode changes and isolates unfinished images by mode", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    f.setDisplay({ status: 0, image_url: "next.bmp", filename: "next" });
    f.failImages(1);
    await f.device.scheduled(env("manual"));
    await f.device.scheduled(env("inputs-changed", mirrorInputs));
    expect(f.device.phase).toBe("ready");
    expect(f.count("next.bmp")).toBe(1);
    expect(f.count("current.bmp")).toBe(1);
    expect(f.count("/api/setup")).toBe(1);
    const restarted = new Device(f.runtime);
    await restarted.scheduled(env("initial"));
    expect(f.count("/api/display")).toBe(3);
    expect(f.count("/api/setup")).toBe(1);
    expect(restarted.mode).toBe("device");
  });

  it("Keeps the new token when a pairing request is queued before switching to mirror mode", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    f.device.pairAgain();
    f.secrets.set("access_token", "mirror-device-key");
    await f.device.scheduled(env("inputs-changed", mirrorInputs));
    expect(f.device.phase).toBe("ready");
    expect(
      f.requests.find(({ url }) => url.pathname.endsWith("/api/display/current"))?.init.headers,
    ).toHaveProperty("Access-Token", "mirror-device-key");
    expect(f.count("/api/setup")).toBe(1);
  });

  it("Uses a bounded mirror interval with its own default", async () => {
    expect(configuration(mirrorInputs, "id").mirrorRefreshDelay).toBe(300_000);
    expect(configuration({ ...mirrorInputs, mirror_refresh: "" }, "id").mirrorRefreshDelay).toBe(
      300_000,
    );
    expect(configuration({ ...mirrorInputs, mirror_refresh: 1 }, "id").mirrorRefreshDelay).toBe(
      10_000,
    );
    expect(
      configuration({ ...mirrorInputs, mirror_refresh: "999999" }, "id").mirrorRefreshDelay,
    ).toBe(86_400_000);
    expect(() => configuration({ ...mirrorInputs, mirror_refresh: "invalid" }, "id")).toThrow();
    const f = mirrorFixture();
    await f.device.scheduled(env("initial", { ...mirrorInputs, mirror_refresh: 60 }));
    expect(f.scheduled.at(-1)).toBe(60_000);
  });
});
