import * as v from "valibot";
import type { Configuration } from "../config.ts";
import { DeviceError, failure, type FailureCode } from "../errors.ts";
import { Transport } from "./transport.ts";

const replyJSON = v.pipe(
  v.string(),
  v.maxLength(65_536),
  v.parseJson(),
  v.custom<Record<string, unknown>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  ),
);
type Fields = v.InferOutput<typeof replyJSON>;
type Endpoint = "setup" | "display" | "display/current" | "current_screen";

function refreshDelay(value: unknown, fallback: number): number {
  const seconds = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.max(Math.round(seconds * 1000), 1000), 7 * 86_400_000)
    : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type DeviceReply = Awaited<ReturnType<Protocol["display"]>>;

export class Protocol {
  private transport: Transport;

  constructor(
    private config: Configuration,
    request: typeof fetch,
    private now: () => number,
    signal?: AbortSignal,
  ) {
    this.transport = new Transport(config, request, now, signal);
  }

  private async api(path: Endpoint | "log", token: string, body?: object) {
    try {
      const response = await this.transport.api(path, token, body);
      const raw = await response.text();
      if (response.status === 401 || response.status === 403)
        throw new DeviceError("authentication");
      return { status: response.status, ok: response.ok, raw };
    } catch (error) {
      throw failure(error, "network");
    }
  }

  private async read(path: Endpoint, token: string): Promise<Fields> {
    const { status, ok, raw } = await this.api(path, token);
    const mirror = path === "display/current" || path === "current_screen";
    const waiting = mirror && [202, 404].includes(status);
    const unregistered = path === "setup" && status === 404;
    if (!ok && !waiting && !unregistered) throw new DeviceError("network");
    const parsed = v.safeParse(replyJSON, raw);
    const fields = parsed.success ? parsed.output : undefined;
    if (waiting) {
      // LaraPaper reports a missing route separately from a device with no screen.
      if (
        path === "display/current" &&
        status === 404 &&
        /^The route (?:\S+\/)?api\/display\/current could not be found\.$/.test(
          text(fields?.message),
        )
      )
        return this.read("current_screen", token);
      throw new DeviceError("no-screen", this.config.mirrorRefreshDelay);
    }
    if (!fields) throw new DeviceError(unregistered ? "network" : "response");
    // LaraPaper and Phoenix report an unregistered device with JSON status 404.
    if (path === "setup" && fields.status === 404)
      return { status: 202, reset_firmware: fields.reset_firmware };
    if (unregistered) throw new DeviceError("network");
    // Terminus and Kuroshiro omit the JSON status on successful device frames.
    if (
      path === "display" &&
      status === 200 &&
      !("status" in fields) &&
      text(fields.image_url).trim()
    )
      return { ...fields, status: 0 };
    return fields;
  }

  private reply(data: Fields, success: number, fixedRefreshDelay?: number) {
    if (this.config.mode === "device" && data.reset_firmware === true)
      throw new DeviceError("registration");
    const waiting = data.status === 202;
    if (!waiting && data.status !== success) {
      throw new DeviceError(
        data.status === 401 || data.status === 403 ? "authentication" : "response",
      );
    }
    const filename = text(data.filename);
    return {
      status: waiting ? ("waiting" as const) : ("ready" as const),
      imageURL: text(data.image_url),
      filename: filename.length <= 1024 ? filename : "",
      refreshDelay:
        fixedRefreshDelay ?? refreshDelay(data.refresh_rate, waiting ? 30_000 : 300_000),
      apiKey: text(data.api_key),
      friendlyId: text(data.friendly_id).slice(0, 128),
      skipUpdate: data.skip_update === true,
      updateFirmware: this.config.mode === "device" && data.update_firmware === true,
    };
  }

  async setup() {
    return this.reply(await this.read("setup", ""), 200);
  }

  async display(token: string) {
    return this.reply(await this.read("display", token), 0);
  }

  async mirror(token: string) {
    const data = await this.read("display/current", token);
    if (data.status === 202 || data.status === 404)
      throw new DeviceError("no-screen", this.config.mirrorRefreshDelay);
    return this.reply(data, 200, this.config.mirrorRefreshDelay);
  }

  image(raw: string, token: string): Promise<ArrayBuffer> {
    return this.transport.image(raw, token);
  }

  async log(token: string, code: FailureCode): Promise<void> {
    const { ok } = await this.api("log", token, {
      logs: [
        {
          id: this.config.id,
          created_at: Math.floor(this.now() / 1000),
          message: `virtual-device:${code}`,
        },
      ],
    });
    if (!ok) throw new DeviceError("network");
  }
}
