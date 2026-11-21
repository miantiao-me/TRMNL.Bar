import { DeviceError } from "./errors.ts";

export const screen = { model: "og", width: 800, height: 480 } as const;
export const dashboardIcon = "lucide:monitor";

export interface Configuration {
  server: string;
  imageOrigin: string;
  id: string;
  mode: "device" | "mirror";
  mirrorRefreshDelay: number;
  binding: string;
}

function httpURL(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 4096
    )
      throw new Error();
    return url;
  } catch {
    throw new DeviceError("configuration");
  }
}

export function configuration(inputs: Record<string, unknown>, generatedId: string): Configuration {
  const server = httpURL(
    typeof inputs.server === "string" ? inputs.server.trim() : "https://trmnl.com",
  );
  if (server.search || server.hash) throw new DeviceError("configuration");
  server.pathname = `${server.pathname.replace(/\/+$/, "")}/`;
  const id =
    typeof inputs.device_id === "string" && inputs.device_id.trim()
      ? inputs.device_id.trim()
      : generatedId;
  if (!/^[\x21-\x7e]{1,128}$/.test(id)) throw new DeviceError("configuration");
  const mode = inputs.mode === "mirror" ? "mirror" : "device";
  const mirrorRefresh = inputs.mirror_refresh;
  const seconds =
    mirrorRefresh == null || (typeof mirrorRefresh === "string" && !mirrorRefresh.trim())
      ? 300
      : typeof mirrorRefresh === "number" || typeof mirrorRefresh === "string"
        ? Number(mirrorRefresh)
        : NaN;
  if (!Number.isFinite(seconds)) throw new DeviceError("configuration");
  const mirrorRefreshDelay = Math.round(Math.min(Math.max(seconds, 10), 86_400) * 1000);
  const imageOrigin =
    typeof inputs.image_origin === "string" && inputs.image_origin.trim()
      ? httpURL(inputs.image_origin.trim()).origin
      : "";
  return {
    server: server.href,
    imageOrigin,
    id,
    mode,
    mirrorRefreshDelay,
    binding: JSON.stringify([server.href, id]),
  };
}

export function virtualDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  bytes[0] = (bytes[0]! & 0xfc) | 0x02;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();
}
