import * as v from "valibot";

export const stateKey = "trmnl:device:v1";
export const credentialKind = "trmnl-device-token-v1";

const image = v.object({
  src: v.pipe(v.string(), v.regex(/^metrix-image:\/\/[a-f0-9]{64}$/)),
  width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4096)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4096)),
  format: v.literal("png"),
});
const mode = v.optional(v.picklist(["device", "mirror"]), "device");
const state = v.pipe(
  v.object({
    version: v.literal(1),
    generatedId: v.string(),
    binding: v.string(),
    mode,
    connection: v.optional(v.picklist(["connected", "disconnecting", "disconnected"])),
    disconnected: v.optional(v.boolean()),
    needsToken: v.optional(v.boolean(), false),
    // Older X profiles retain their identity and connection state during migration.
    model: v.picklist(["", "og", "x"]),
    image: v.fallback(v.optional(image), undefined),
    filename: v.string(),
    nextPollAt: v.pipe(v.number(), v.finite()),
    retryAt: v.optional(v.pipe(v.number(), v.finite()), 0),
    friendlyId: v.string(),
    waiting: v.optional(v.boolean(), false),
    revision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
  }),
  v.transform(({ disconnected, connection, ...fields }) => ({
    ...fields,
    // Legacy state cannot tell whether credential cleanup finished.
    connection: connection ?? (disconnected ? "disconnecting" : "connected"),
  })),
);

// Signed image URLs remain encrypted outside the system credential size limit.
export const frameSchema = v.object({
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  nextPollAt: v.pipe(v.number(), v.finite()),
  mode,
  model: v.picklist(["og", "x"]),
  imageURL: v.pipe(v.string(), v.minLength(1)),
  filename: v.string(),
  pairing: v.boolean(),
  updateFirmware: v.boolean(),
});
export const credentialSchema = v.object({
  kind: v.literal(credentialKind),
  binding: v.string(),
  token: v.string(),
  key: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
});
export type ManagedImage = v.InferOutput<typeof image>;
export type State = v.InferOutput<typeof state>;
export type Frame = v.InferOutput<typeof frameSchema>;
export type Credential = v.InferOutput<typeof credentialSchema> & { frame?: Frame };

export function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function restore(storage: Pick<Storage, "getItem">, makeId: () => string): State {
  let raw = "";
  try {
    raw = storage.getItem(stateKey) ?? "";
  } catch {
    /* Storage may be unavailable during setup. */
  }
  const result = v.safeParse(state, raw.length <= 16_384 ? parseJSON(raw) : undefined);
  return result.success
    ? result.output
    : {
        version: 1,
        generatedId: makeId(),
        binding: "",
        mode: "device",
        connection: "connected",
        needsToken: false,
        model: "",
        filename: "",
        nextPollAt: 0,
        retryAt: 0,
        friendlyId: "",
        waiting: false,
        revision: 0,
      };
}
