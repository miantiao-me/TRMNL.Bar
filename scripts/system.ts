import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const sourceFile = resolve(root, "dist/TRMNL.bar");
export const run = promisify(execFile);

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJSON(path: string, data: unknown): void {
  const file = openSync(path, "w", 0o600);
  try {
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  } finally {
    closeSync(file);
  }
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export async function availablePort(): Promise<number> {
  const listener = createServer();
  try {
    await new Promise<void>((ready, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", ready);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a local port");
    return address.port;
  } finally {
    if (listener.listening) await new Promise<void>((done) => listener.close(() => done()));
  }
}

export class WaitTimeout extends Error {}

export async function waitFor<T>(
  check: () => T | Promise<T>,
  description: string,
  child?: ChildProcess,
  timeout = 30_000,
): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout;
  do {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `The process exited (${child.exitCode ?? child.signalCode}) while waiting for ${description}`,
      );
    }
    const result = await check();
    if (result) return result;
    await sleep(50);
  } while (performance.now() < deadline);
  throw new WaitTimeout(`Timed out waiting for ${description}`);
}

export async function withProcess<T>(
  command: string[],
  options: { log: string; cwd?: string; env?: NodeJS.ProcessEnv; append?: boolean },
  action: (child: ChildProcess, closed: Promise<number | null>) => Promise<T>,
): Promise<T> {
  const file = openSync(options.log, options.append ? "a" : "w", 0o600);
  const [executable, ...args] = command;
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", file, file],
  });
  closeSync(file);
  const closed = new Promise<number | null>((done) => child.once("close", done));
  const started = new Promise<void>((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  const interrupt = () => child.kill();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await started;
    return await action(child, closed);
  } catch (error) {
    throw new Error(`${executable} failed. See ${options.log}`, { cause: error });
  } finally {
    const kill = child.kill() ? setTimeout(() => child.kill("SIGKILL"), 8000) : undefined;
    try {
      await closed;
    } finally {
      clearTimeout(kill);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}

export async function runLogged(
  command: string[],
  cwd: string,
  log: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await withProcess(command, { cwd, log, env, append: true }, async (child, closed) => {
    const code = await closed;
    if (code !== 0) throw new Error(`${command[0]} exited (${code ?? child.signalCode})`);
  });
}

export function requireMacOS(): void {
  if (process.platform !== "darwin")
    throw new Error("Native verification requires a macOS desktop session");
}

export function main(entry: ImportMeta, execute: () => Promise<void>): void {
  if (!entry.main) return;
  void execute().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
