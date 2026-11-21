import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import type { Rectangle } from "./automation.ts";
import type { Application, NativeHost } from "./native.ts";

export function pngSize(image: Buffer) {
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

export async function pixelError(
  expected: string,
  actual: string,
  rectangle: Rectangle,
  contentWidth: number,
): Promise<number> {
  const { width, height } = pngSize(readFileSync(expected));
  const size = {
    width: 32,
    height: Math.max(1, Math.round((32 * height) / width)),
    fit: "fill",
    kernel: "cubic",
  } as const;
  const screenshot = sharp(actual).toColourspace("srgb").removeAlpha();
  const scale = (await screenshot.metadata()).width / contentWidth;
  const left = Math.round(rectangle.x * scale);
  const top = Math.round(rectangle.y * scale);
  const [original, cropped] = await Promise.all([
    sharp(expected).toColourspace("srgb").removeAlpha().resize(size).raw().toBuffer(),
    screenshot
      .extract({
        left,
        top,
        width: Math.round((rectangle.x + rectangle.width) * scale) - left,
        height: Math.round((rectangle.y + rectangle.height) * scale) - top,
      })
      .resize(size)
      .raw()
      .toBuffer(),
  ]);
  const colors = new Map<number, number>();
  let background = 0;
  let most = 0;
  for (let i = 0; i < original.length; i += 3) {
    const color = original.readUIntBE(i, 3);
    const count = (colors.get(color) ?? 0) + 1;
    colors.set(color, count);
    if (count > most) {
      background = color;
      most = count;
    }
  }
  const red = background >>> 16;
  const green = (background >>> 8) & 255;
  const blue = background & 255;
  let all = 0;
  let content = 0;
  let count = 0;
  for (let i = 0; i < original.length; i += 3) {
    const error =
      Math.abs(original[i] - cropped[i]) +
      Math.abs(original[i + 1] - cropped[i + 1]) +
      Math.abs(original[i + 2] - cropped[i + 2]);
    all += error;
    const difference =
      0.299 * Math.abs(original[i] - red) +
      0.587 * Math.abs(original[i + 1] - green) +
      0.114 * Math.abs(original[i + 2] - blue);
    if (difference > 16) {
      content += error;
      count++;
    }
  }
  return Math.max(all / original.length, count ? content / (count * 3) : 0);
}

export async function captureDevice(
  native: NativeHost,
  app: Application,
  window: number,
  name: string,
  source: string,
  capture = native.capture.bind(native),
): Promise<number> {
  const expected = native.imageFile(source);
  const { width, height } = pngSize(readFileSync(expected));
  const deadline = performance.now() + 10_000;
  let error: number;
  do {
    await capture(app, window, name);
    const stage = (await app.client.tree(window)).nodes.find(
      (node) => node.key === `stage:${native.identifier}`,
    )?.bounds;
    const bounds = (await app.client.call("windows")).windows.find(
      (item) => item.id === window,
    )?.contentBounds;
    assert(stage && bounds, "The native preview bounds are missing");
    // Skip the 1 px card border and compare the content separately so white space cannot hide missing text.
    error = await pixelError(
      expected,
      join(native.artifacts, `${name}.png`),
      {
        x: stage.x + (stage.width - 320) / 2 + 1,
        y: stage.y + 21,
        width: 320,
        height: (320 * height) / width,
      },
      bounds.width,
    );
    if (error < 12) return Number(error.toFixed(3));
    await sleep(50);
  } while (performance.now() < deadline);
  throw new Error(
    `${name}: The native preview differs from the server image (pixel error ${error.toFixed(3)})`,
  );
}
