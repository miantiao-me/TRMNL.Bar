import type { ManagedImage } from "../storage/state.ts";
export type { ManagedImage } from "../storage/state.ts";

export interface Env {
  reason: string;
  inputs: Record<string, unknown>;
}

export interface Host {
  readonly platform?: string;
  caniuse(name: string): Promise<boolean>;
  image: { load(source: string | ArrayBuffer | ArrayBufferView): Promise<ManagedImage> };
  secret(name: string): string;
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  schedule(delayMs: number | null): void;
  openURL(url: string): void;
  invalidate(): void;
}

export interface Runtime {
  host: Host;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  request: typeof fetch;
  now: () => number;
  makeId: () => string;
}

declare global {
  const $metrix: Host & { system(command: "app.locale"): Promise<string> };
}
