export type FailureCode =
  | "configuration"
  | "network"
  | "timeout"
  | "response"
  | "no-screen"
  | "authentication"
  | "registration"
  | "rate-limit"
  | "image-origin"
  | "image"
  | "credentials"
  | "cancelled"
  | "unsupported";

export class DeviceError extends Error {
  constructor(
    public readonly code: FailureCode,
    public readonly retryAfter = 30_000,
    public readonly origin = "",
  ) {
    super(code);
  }
}

export function cancelled(error: unknown): boolean {
  if (error instanceof DeviceError) return error.code === "cancelled";
  if (typeof error !== "object" || error === null) return false;
  return (
    ("code" in error && error.code === "cancelled") ||
    ("name" in error && error.name === "AbortError") ||
    ("message" in error &&
      typeof error.message === "string" &&
      /context cancel(?:ed|led)/i.test(error.message))
  );
}

export function failure(error: unknown, fallback: FailureCode): DeviceError {
  if (error instanceof DeviceError) return error;
  if (cancelled(error)) return new DeviceError("cancelled");
  if (error instanceof Error && error.name === "TimeoutError") return new DeviceError("timeout");
  return new DeviceError(fallback);
}
