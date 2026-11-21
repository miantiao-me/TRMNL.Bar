import { gcm } from "@noble/ciphers/aes.js";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import * as v from "valibot";
import { frameSchema, parseJSON, type Frame } from "./state.ts";

export const frameKey = "trmnl:frame:v1";
const sealedFrame = v.object({
  nonce: v.pipe(v.string(), v.regex(/^[a-f0-9]{24}$/)),
  data: v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{2}){16,}$/)),
});
export const newKey = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const encoder = new TextEncoder();

export function seal(frame: Frame, key: string, binding: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = gcm(hexToBytes(key), nonce, encoder.encode(binding));
  return JSON.stringify({
    nonce: bytesToHex(nonce),
    data: bytesToHex(cipher.encrypt(encoder.encode(JSON.stringify(frame)))),
  });
}

export function open(raw: string, key: string, binding: string): Frame | undefined {
  try {
    if (raw.length > 512 * 1024) return;
    const parsed = v.safeParse(sealedFrame, parseJSON(raw));
    if (!parsed.success) return;
    const cipher = gcm(hexToBytes(key), hexToBytes(parsed.output.nonce), encoder.encode(binding));
    const result = v.safeParse(
      frameSchema,
      parseJSON(new TextDecoder().decode(cipher.decrypt(hexToBytes(parsed.output.data)))),
    );
    return result.success ? result.output : undefined;
  } catch {
    return undefined;
  }
}
