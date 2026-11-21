import { screen, type Configuration } from "../config.ts";
import { DeviceError, failure } from "../errors.ts";

const firmwareVersion = "1.6.0";
const redirects = [301, 302, 303, 307, 308];

export class Transport {
  private server: URL;

  constructor(
    private config: Configuration,
    private request: typeof fetch,
    private now: () => number,
    private signal?: AbortSignal,
  ) {
    this.server = new URL(config.server);
  }

  api(path: string, token: string, body?: object): Promise<Response> {
    return this.response(new URL(`api/${path}`, this.server), token, false, body);
  }

  async image(raw: string, token: string): Promise<ArrayBuffer> {
    try {
      const response = await this.response(this.imageURL(raw), token, true);
      const body = await response.arrayBuffer();
      if (!response.ok || body.byteLength === 0 || body.byteLength > 8 * 1024 * 1024)
        throw new DeviceError("image");
      return body;
    } catch (error) {
      throw failure(error, "image");
    }
  }

  private headers(token: string): Record<string, string> {
    const authorization: Record<string, string> = token ? { "Access-Token": token } : {};
    if (this.config.mode === "mirror") return authorization;
    return {
      ID: this.config.id,
      Model: screen.model,
      "FW-Version": firmwareVersion,
      Width: String(screen.width),
      Height: String(screen.height),
      ...authorization,
    };
  }

  private imageURL(raw: string, base = this.server): URL {
    let image: URL;
    try {
      image = new URL(raw, base);
    } catch {
      throw new DeviceError("image");
    }
    if (!["http:", "https:"].includes(image.protocol) || image.username || image.password)
      throw new DeviceError("image");
    if (image.origin !== this.server.origin && image.origin !== this.config.imageOrigin)
      throw new DeviceError("image-origin", 30_000, image.origin);
    return image;
  }

  private async response(
    url: URL,
    token: string,
    asset: boolean,
    body?: object,
  ): Promise<Response> {
    let sendIdentity = url.origin === this.server.origin;
    for (let hop = 0; hop < 6; hop++) {
      this.signal?.throwIfAborted();
      const response = await this.request(url.href, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        signal: this.signal,
        headers: {
          ...(sendIdentity ? this.headers(token) : {}),
          ...(!asset && this.config.mode === "mirror" ? { Accept: "application/json" } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 429) {
        const retry = response.headers.get("Retry-After");
        const delay =
          retry && /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry ?? "") - this.now();
        throw new DeviceError("rate-limit", Number.isFinite(delay) && delay > 0 ? delay : 60_000);
      }
      if (!redirects.includes(response.status)) return response;
      await response.arrayBuffer();
      const location = response.headers.get("Location");
      if (!location) throw new DeviceError(asset ? "image" : "response");
      if (asset) {
        url = this.imageURL(location, url);
        sendIdentity &&= url.origin === this.server.origin;
      } else {
        const next = new URL(location, url);
        if (next.origin !== this.server.origin || next.username || next.password)
          throw new DeviceError("response");
        url = next;
      }
      if ([301, 302, 303].includes(response.status)) body = undefined;
    }
    throw new DeviceError(asset ? "image" : "response");
  }
}
