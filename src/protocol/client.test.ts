import { describe, expect, it } from "vite-plus/test";
import { configuration, virtualDeviceId } from "../config.ts";
import { DeviceError } from "../errors.ts";
import { Protocol } from "./client.ts";

const config = configuration(
  { server: "https://device.example/prefix", image_origin: "https://cdn.example", model: "x" },
  "02:11:22:33:44:55",
);
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });

function protocol(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const client = new Protocol(
    config,
    async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push({ url, init: init ?? {} });
      return handler(url, init ?? {});
    },
    () => 1_000_000,
  );
  return { client, calls };
}

describe("Standard device protocol", () => {
  it("Preserves the deployment prefix and limits headers to supported device capabilities", async () => {
    const { client, calls } = protocol(() =>
      json({ status: 0, image_url: "image.bmp", refresh_rate: 17 }),
    );
    const reply = await client.display("test-key");
    expect(calls[0]?.url.href).toBe("https://device.example/prefix/api/display");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      ID: config.id,
      Model: "og",
      Width: "800",
      Height: "480",
      "Access-Token": "test-key",
    });
    expect(headers).not.toHaveProperty("Battery-Voltage");
    expect(headers).not.toHaveProperty("Colors");
    expect(reply.refreshDelay).toBe(17_000);
    expect(await client.image(reply.imageURL, "test-key")).toBeInstanceOf(ArrayBuffer);
    expect(calls[1]?.url.href).toBe("https://device.example/prefix/image.bmp");
  });

  it("Checks HTTP status and the distinct JSON success codes for setup and display", async () => {
    const { client } = protocol((url) =>
      url.pathname.endsWith("setup")
        ? json({ status: 200, api_key: "paired-key", friendly_id: "ABC123" })
        : json({ status: 202, refresh_rate: 12 }),
    );
    expect(await client.setup()).toMatchObject({
      status: "ready",
      apiKey: "paired-key",
      friendlyId: "ABC123",
    });
    expect(await client.display("paired-key")).toMatchObject({
      status: "waiting",
      refreshDelay: 12_000,
    });
    await expect(protocol(() => json({ status: 200 })).client.display("k")).rejects.toMatchObject({
      code: "response",
    });
    await expect(
      protocol(() => json({ status: 0 }, 503)).client.display("k"),
    ).rejects.toMatchObject({ code: "network" });
    await expect(
      protocol(() => json({ status: 500, reset_firmware: true })).client.display("k"),
    ).rejects.toMatchObject({ code: "registration" });
    await expect(
      protocol(() => json({ status: 0 }, 401)).client.display("k"),
    ).rejects.toMatchObject({ code: "authentication" });
  });

  it("Distinguishes an unregistered device from a missing setup route", async () => {
    for (const http of [200, 404]) {
      await expect(
        protocol(() =>
          json({ status: 404, message: "MAC Address not registered" }, http),
        ).client.setup(),
      ).resolves.toMatchObject({ status: "waiting", refreshDelay: 30_000 });
    }
    await expect(
      protocol(() => new Response("404 Not Found", { status: 404 })).client.setup(),
    ).rejects.toMatchObject({ code: "network" });
  });

  it.each([
    [{ filename: "frame.bmp" }, 200],
    [{ image_url: "  " }, 200],
    [{ status: null, image_url: "frame.bmp" }, 200],
    [{ status: 200, image_url: "frame.bmp" }, 200],
    [{ image_url: "frame.bmp" }, 202],
  ])("Rejects a device screen without a valid success status %j (HTTP %i)", async (data, http) => {
    await expect(protocol(() => json(data, http)).client.display("k")).rejects.toMatchObject({
      code: "response",
    });
  });

  it("Infers status for successful screens and honors explicit server errors and resets", async () => {
    const image = { image_url: "frame.bmp" };
    await expect(protocol(() => json(image)).client.display("k")).resolves.toMatchObject({
      status: "ready",
      imageURL: "frame.bmp",
    });
    await expect(
      protocol(() => json({ ...image, status: 403 })).client.display("k"),
    ).rejects.toMatchObject({ code: "authentication" });
    await expect(
      protocol(() => json({ ...image, reset_firmware: true })).client.display("k"),
    ).rejects.toMatchObject({ code: "registration" });
  });

  it("Accepts successful plain text and empty 204 log responses and checks for HTTP errors", async () => {
    for (const response of [new Response("OK"), new Response(null, { status: 204 })]) {
      const { client, calls } = protocol(() => response);
      await expect(client.log("log-key", "image")).resolves.toBeUndefined();
      expect(calls[0]?.url.pathname).toBe("/prefix/api/log");
      expect(calls[0]?.init.method).toBe("POST");
      expect(calls[0]?.init.headers).toHaveProperty("Access-Token", "log-key");
    }
    await expect(
      protocol(() => new Response(null, { status: 401 })).client.log("k", "image"),
    ).rejects.toMatchObject({ code: "authentication" });
    await expect(
      protocol(() => new Response(null, { status: 503 })).client.log("k", "image"),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("Reads Retry-After seconds and dates from HTTP 429 responses", async () => {
    await expect(
      protocol(() => json({}, 429, { "Retry-After": "37" })).client.display("k"),
    ).rejects.toMatchObject({ code: "rate-limit", retryAfter: 37_000 });
    const date = new Date(1_045_000).toUTCString();
    await expect(
      protocol(() => json({}, 429, { "Retry-After": date })).client.display("k"),
    ).rejects.toMatchObject({ retryAfter: 45_000 });
    await expect(
      protocol(() => json({}, 429, { "Retry-After": "172800" })).client.display("k"),
    ).rejects.toMatchObject({ retryAfter: 172_800_000 });
  });

  it("Keeps device tokens from a separate CDN and its redirect targets", async () => {
    const { client, calls } = protocol((url) =>
      url.hostname === "device.example"
        ? new Response("", { status: 302, headers: { Location: "https://cdn.example/frame.bmp" } })
        : new Response(new Uint8Array([1, 2, 3])),
    );
    expect(new Uint8Array(await client.image("/frame", "secret-key"))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.headers).toHaveProperty("Access-Token", "secret-key");
    expect(calls[1]?.init.headers).toEqual({});
    await expect(
      client.image("https://unapproved.example/frame.png", "secret-key"),
    ).rejects.toMatchObject({
      code: "image-origin",
    });
    expect(calls).toHaveLength(2);
  });

  it("Keeps image redirects anonymous after leaving the server, even on return", async () => {
    const { client, calls } = protocol((url) => {
      if (url.pathname === "/final.bmp") return new Response(new Uint8Array([1]));
      const target =
        url.hostname === "device.example"
          ? "https://cdn.example/next"
          : "https://device.example/final.bmp";
      return new Response(null, { status: 302, headers: { Location: target } });
    });
    await client.image("/first", "secret-key");
    expect(calls[0]?.init.headers).toHaveProperty("Access-Token", "secret-key");
    expect(calls.slice(1).map(({ init }) => init.headers)).toEqual([{}, {}]);
  });

  it("Follows API redirects within the server origin only", async () => {
    const { client, calls } = protocol(
      () =>
        new Response("", {
          status: 307,
          headers: { Location: "https://cdn.example/steal" },
        }),
    );
    await expect(client.display("secret-key")).rejects.toMatchObject({ code: "response" });
    expect(calls).toHaveLength(1);
    const same = protocol((url) =>
      url.pathname.endsWith("display")
        ? new Response("", { status: 308, headers: { Location: "./display/" } })
        : json({ status: 0, skip_update: true }),
    );
    expect((await same.client.display("k")).skipUpdate).toBe(true);
    expect(same.calls[1]?.url.pathname).toBe("/prefix/api/display/");
  });

  it("Checks authorization at every image redirect, including redirects from an approved CDN", async () => {
    const { client, calls } = protocol((url) => {
      const target =
        url.hostname === "device.example"
          ? "https://cdn.example/next"
          : "https://unapproved.example/private";
      return new Response(null, { status: 302, headers: { Location: target } });
    });
    await expect(client.image("/frame", "secret-key")).rejects.toMatchObject({
      code: "image-origin",
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.url.hostname === "unapproved.example")).toBe(false);
    expect(calls[1]?.init.headers).toEqual({});
  });

  it("Rejects invalid responses and embedded credentials, converts refresh seconds, and generates a locally administered ID", async () => {
    await expect(
      protocol(() => new Response("<html>error</html>")).client.setup(),
    ).rejects.toMatchObject({ code: "response" });
    expect(() => configuration({ server: "https://user:password@example.com" }, "id")).toThrow(
      DeviceError,
    );
    expect(() => configuration({ server: "https://example.com/?token=secret" }, "id")).toThrow(
      DeviceError,
    );
    expect(() => configuration({ server: "file:///tmp" }, "id")).toThrow(DeviceError);
    await expect(
      protocol(() => json({ status: 0, refresh_rate: "21" })).client.display("k"),
    ).resolves.toMatchObject({ refreshDelay: 21_000 });
    await expect(
      protocol(() => json({ status: 0, refresh_rate: 0 })).client.display("k"),
    ).resolves.toMatchObject({ refreshDelay: 300_000 });
    const id = virtualDeviceId();
    expect(id).toMatch(/^[A-F0-9]{2}(?::[A-F0-9]{2}){5}$/);
    expect(parseInt(id.slice(0, 2), 16) & 3).toBe(2);
  });
});
