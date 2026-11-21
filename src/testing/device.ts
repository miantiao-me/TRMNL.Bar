import { Device } from "../device/controller.ts";
import type { Env, ManagedImage, Runtime } from "../runtime/host.ts";

export const inputs = { server: "https://server.example/prefix" };
export const mirrorInputs = { ...inputs, mode: "mirror" };
export const env = (reason = "interval", values: Record<string, unknown> = inputs): Env => ({
  reason,
  inputs: values,
});
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });
export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function fixture() {
  const storage = new Map<string, string>();
  const secrets = new Map<string, string>();
  const images = new Map<string, ManagedImage>();
  const requests: { url: URL; init: RequestInit }[] = [];
  const scheduled: (number | null)[] = [];
  const opened: string[] = [];
  let now = 1_000_000;
  let imageNumber = 0;
  let imageFailures = 0;
  let available = true;
  let setupReply: unknown = { status: 200, api_key: "private-test-token", friendly_id: "ABC123" };
  let displayReply: unknown = {
    status: 0,
    image_url: "images/first.bmp",
    filename: "first",
    refresh_rate: 61,
  };
  let mirrorReply: unknown = {
    status: 200,
    image_url: "images/current.bmp",
    filename: "current",
    refresh_rate: 61,
  };
  let mirrorHTTP = 200;
  let displayHTTP = 200;
  let displayHeaders: HeadersInit | undefined;
  const runtime: Runtime = {
    now: () => now,
    makeId: () => "02:11:22:33:44:55",
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
    host: {
      caniuse: async () => available,
      secret: (name) => {
        const value = secrets.get(name);
        if (value === undefined) throw new Error("secret is not available");
        return value;
      },
      setSecret: async (name, value) => {
        secrets.set(name, value);
      },
      deleteSecret: async (name) => {
        secrets.delete(name);
      },
      schedule: (delay) => {
        scheduled.push(delay);
      },
      openURL: (url) => {
        opened.push(url);
      },
      invalidate: () => {},
      image: {
        load: async (source) => {
          if (typeof source === "string") {
            const image = images.get(source);
            if (!image) throw new Error("not found");
            return image;
          }
          const src = `metrix-image://${String(++imageNumber).padStart(64, "0")}`;
          const image: ManagedImage = { src, width: 800, height: 480, format: "png" };
          images.set(src, image);
          return image;
        },
      },
    },
    request: async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push({ url, init: init ?? {} });
      if (url.pathname.endsWith("/api/setup")) return json(setupReply);
      if (url.pathname.endsWith("/api/display/current")) return json(mirrorReply, mirrorHTTP);
      if (url.pathname.endsWith("/api/display"))
        return json(displayReply, displayHTTP, displayHeaders);
      if (url.pathname.endsWith("/api/log")) return json({ status: 0 });
      if (imageFailures > 0) {
        imageFailures--;
        return new Response("failed", { status: 503 });
      }
      return new Response(new Uint8Array([66, 77, 1, 2]));
    },
  };
  return {
    runtime,
    storage,
    secrets,
    images,
    requests,
    scheduled,
    opened,
    device: new Device(runtime),
    advance: (ms: number) => {
      now += ms;
    },
    failImages: (count: number) => {
      imageFailures = count;
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
    setSetup: (value: unknown) => {
      setupReply = value;
    },
    setMirror: (value: unknown, status = 200) => {
      mirrorReply = value;
      mirrorHTTP = status;
    },
    setDisplay: (value: unknown, status = 200, headers?: HeadersInit) => {
      displayReply = value;
      displayHTTP = status;
      displayHeaders = headers;
    },
    count: (path: string) => requests.filter((r) => r.url.pathname.endsWith(path)).length,
  };
}

export function mirrorFixture() {
  const context = fixture();
  context.secrets.set("access_token", "mirror-device-key");
  return context;
}
