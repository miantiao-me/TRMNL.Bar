import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import sharp from "sharp";
import { privateDirectory } from "../system.ts";

export const key = "device-verification-key";

const glyphs = {
  T: [31, 4, 4, 4, 4, 4, 4],
  R: [30, 17, 17, 30, 20, 18, 17],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 25, 21, 19, 19, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  S: [15, 16, 16, 14, 1, 1, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  V: [17, 17, 17, 17, 17, 10, 4],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "2": [14, 17, 1, 2, 4, 8, 31],
};

function bitmap(pixels: Buffer, width: number, height: number): Buffer {
  const stride = Math.ceil(width / 32) * 4;
  const bmp = Buffer.alloc(62 + stride * height);
  bmp.write("BM");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(62, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(1, 28);
  bmp.writeUInt32LE(stride * height, 34);
  bmp.writeInt32LE(2835, 38);
  bmp.writeInt32LE(2835, 42);
  bmp.writeUInt32LE(2, 46);
  bmp.writeUInt32LE(2, 50);
  bmp.fill(255, 58, 61);
  for (let y = 0; y < height; y++) {
    const row = 62 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] >= 128) bmp[row + (x >> 3)] |= 128 >> (x % 8);
    }
  }
  return bmp;
}

export async function fixtures(directory: string, width = 800, height = 480) {
  privateDirectory(directory);
  const pixels = Buffer.alloc(width * height, 255);
  function box(x: number, y: number, w: number, h: number, color = 0) {
    for (let row = y; row < y + h; row++) pixels.fill(color, row * width + x, row * width + x + w);
  }
  function label(text: string, x: number, y: number, scale: number) {
    for (const letter of text) {
      glyphs[letter as keyof typeof glyphs].forEach((mask, row) => {
        for (let col = 0; col < 5; col++) {
          if (mask & (16 >> col)) box(x + col * scale, y + row * scale, scale, scale);
        }
      });
      x += 6 * scale;
    }
  }
  label("TRMNL", 30, 28, 6);
  label("42", 30, 130, 19);
  for (const [y, w, gray] of [
    [145, 430, 0],
    [215, 350, 72],
    [285, 270, 136],
  ])
    box(300, y, w, 38, gray);
  box(28, 397, 744, 3);
  label("SERVER", 30, 425, 4);
  const image = sharp(pixels, { raw: { width, height, channels: 1 } }).toColourspace("b-w");
  const images = {
    png: await image.clone().png().toBuffer(),
    jpeg: await image.clone().jpeg().toBuffer(),
    bmp: bitmap(pixels, width, height),
  };
  for (const [kind, data] of Object.entries(images))
    writeFileSync(join(directory, `frame.${kind}`), data);
  return images;
}

type ImageFormat = keyof Awaited<ReturnType<typeof fixtures>>;

export interface Fixture {
  requests: {
    path: string;
    image_server: boolean;
    id: string;
    token_present: boolean;
    model: string;
    firmware: string;
  }[];
  logs: unknown[];
  format: ImageFormat;
  filename: string;
  fail_images: boolean;
  use_cdn?: boolean;
  no_screen?: boolean;
  credential_leak?: boolean;
  refresh_rate?: number;
  server_port?: number;
  cdn_port?: number;
}

export function requestCount(fixture: Fixture, path: string): number {
  return fixture.requests.filter((request) => request.path === path).length;
}

async function logRequest(request: IncomingMessage, fixture: Fixture): Promise<number> {
  if (request.url !== "/prefix/api/log" || request.headers["access-token"] !== key) return 404;
  let text = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 8192) return 413;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return 400;
  }
  if (JSON.stringify(payload).includes(key)) return 400;
  fixture.logs.push(payload);
  return 200;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  state: Fixture,
  images: Awaited<ReturnType<typeof fixtures>>,
  imageServer: boolean,
): Promise<void> {
  const json = (data: object, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  };
  if (request.method === "POST") {
    const status = await logRequest(request, state);
    json({ status: status === 200 ? 0 : status }, status);
    return;
  }
  const path = request.url?.split("?", 1)[0] ?? "";
  const token = request.headers["access-token"];
  const header = (name: string) => String(request.headers[name] ?? "");
  state.requests.push({
    path,
    image_server: imageServer,
    id: header("id"),
    token_present: Boolean(token),
    model: header("model"),
    firmware: header("fw-version"),
  });
  if (path === "/prefix/api/setup") {
    json({ status: 200, api_key: key, friendly_id: "VIRTUAL" });
  } else if (path === "/prefix/api/display" || path === "/prefix/api/display/current") {
    if (token !== key) return json({ status: 401 }, 401);
    const mirror = path.endsWith("/current");
    if (mirror && state.no_screen) return json({ status: 404 }, 404);
    const name = `frame.${state.format}`;
    const imageURL =
      !mirror && state.use_cdn
        ? `http://127.0.0.1:${state.cdn_port}/images/${name}`
        : `screens/${name}`;
    json({
      status: mirror ? 200 : 0,
      image_url: imageURL,
      filename: `${state.filename}.${state.format}`,
      refresh_rate: mirror ? 1 : state.refresh_rate,
    });
  } else if (path.startsWith("/prefix/screens/") || path.startsWith("/images/")) {
    if (imageServer && token) state.credential_leak = true;
    if (state.fail_images) return json({ unavailable: true }, 503);
    const kind = path.split(".").at(-1) as ImageFormat;
    if (!Object.hasOwn(images, kind)) return json({ status: 404 }, 404);
    response.writeHead(200, { "Content-Type": `image/${kind}` }).end(images[kind]);
  } else {
    json({ status: 404 }, 404);
  }
}

export async function serving<T>(
  state: Fixture,
  images: Awaited<ReturnType<typeof fixtures>>,
  action: () => Promise<T>,
): Promise<T> {
  const servers = [];
  try {
    for (const name of ["server_port", "cdn_port"] as const) {
      const server = createServer((request, response) => {
        void handle(request, response, state, images, name === "cdn_port").catch(
          (error: unknown) => {
            response.destroy(error instanceof Error ? error : undefined);
          },
        );
      });
      servers.push(server);
      await new Promise<void>((ready, reject) => {
        server.once("error", reject);
        server.listen(state[name] ?? 0, "127.0.0.1", ready);
      });
      state[name] = (server.address() as AddressInfo).port;
    }
    return await action();
  } finally {
    await Promise.all(
      servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  }
}
