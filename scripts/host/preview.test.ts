import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { pixelError } from "./preview.ts";

let directory: string;
let expected: string;
let actual: string;
const full = { x: 0, y: 0, width: 800, height: 480 };

function canvas(width: number, height: number, background: string) {
  return sharp({ create: { width, height, channels: 3, background } });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "trmnl-preview-"));
  expected = join(directory, "expected.png");
  actual = join(directory, "actual.png");
  const black = await canvas(81, 41, "black").png().toBuffer();
  await canvas(800, 480, "white")
    .composite([{ input: black, left: 100, top: 100 }])
    .png()
    .toFile(expected);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("Identical screens have zero pixel error", async () => {
  copyFileSync(expected, actual);
  expect(await pixelError(expected, actual, full, 800)).toBe(0);
});

test("Detects missing content on a white background", async () => {
  await canvas(800, 480, "white").png().toFile(actual);
  expect(await pixelError(expected, actual, full, 800)).toBeGreaterThan(12);
});

test("Compares the correct region at the window backing scale", async () => {
  const image = await sharp(expected).resize(640, 384).png().toBuffer();
  await canvas(1000, 424, "#e6e6e6")
    .composite([{ input: image, left: 180, top: 40 }])
    .png()
    .toFile(actual);
  expect(
    await pixelError(expected, actual, { x: 90, y: 20, width: 320, height: 192 }, 500),
  ).toBeLessThan(12);
});
