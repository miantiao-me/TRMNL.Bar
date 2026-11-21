import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { availablePort, root, run, runLogged, waitFor, withProcess } from "../system.ts";

export const external = join(root, "dist/independent-servers");
export const projects = {
  fastapi: {
    repository: "usetrmnl/byos_fastapi",
    commit: "10d16d73f696a26cc9843456adbd558fb4699d91",
  },
  tiding: { repository: "srsatt/tiding", commit: "8a2e6850aec839544cb0c13146a6914d37ff6165" },
};
export type Server = keyof typeof projects;

export function selectedServers(name?: string): Server[] {
  if (!name) return ["fastapi", "tiding"];
  assert(name === "fastapi" || name === "tiding", "Use fastapi or tiding for --server");
  return [name];
}

function directory(name: Server): string {
  return join(external, projects[name].repository.split("/")[1]);
}

async function download(name: Server, target: string): Promise<void> {
  const { repository, commit } = projects[name];
  const staging = mkdtempSync(join(external, `${name}-`));
  try {
    const options = {
      cwd: staging,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    };
    await run("git", ["init", "-q"], options);
    await run(
      "git",
      ["fetch", "--depth=1", `https://github.com/${repository}.git`, commit],
      options,
    );
    await run("git", ["checkout", "--detach", commit], options);
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function prepare(names: Server[]): Promise<void> {
  for (const name of names) {
    const target = directory(name);
    if (!existsSync(target)) await download(name, target);
    const log = join(target, "setup.log");
    if (name === "fastapi") {
      if (!existsSync(join(target, ".venv"))) {
        await runLogged(["uv", "venv", "--python", "3.13", ".venv"], target, log);
      }
      await runLogged(
        ["uv", "pip", "install", "--python", ".venv/bin/python", "-r", "requirements.txt"],
        target,
        log,
      );
    } else {
      await runLogged(["bun", "install"], target, log);
    }
  }
}

export async function withServer<T>(
  name: Server,
  action: (base: string) => Promise<T>,
): Promise<T> {
  const target = directory(name);
  assert(existsSync(target), `The ${name} source is missing. Run with --prepare first`);
  const port = String(await availablePort());
  const base = `http://127.0.0.1:${port}`;
  const database = join(target, "data/verification.db");
  const fastapi = name === "fastapi";
  if (!fastapi) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(database + suffix, { force: true });
  }
  const command = fastapi
    ? [
        join(target, ".venv/bin/python"),
        "-m",
        "uvicorn",
        "trmnl_server.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        port,
        "--log-level",
        "warning",
      ]
    : ["bun", "run", "src/index.ts"];
  const env = fastapi
    ? {
        ...process.env,
        SERVER_PORT: port,
        REFRESH_TIME: "3600",
        SETUP_API_KEY: "independent-fastapi-verification",
        LOG_LEVEL: "INFO",
      }
    : {
        ...process.env,
        PORT: port,
        TIDING_BOOTSTRAP_DB: "1",
        TIDING_ADMIN_PIN: "independent-server-verification",
        API_URL: base,
        DB_PATH: database,
      };
  const health = base + (fastapi ? "/settings" : "/api/health");
  return withProcess(
    command,
    { cwd: target, env, log: join(external, `${name}.log`) },
    async (child) => {
      await waitFor(
        async () => {
          const response = await fetch(health, { signal: AbortSignal.timeout(1000) }).catch(
            () => undefined,
          );
          await response?.body?.cancel();
          return response?.ok;
        },
        `${name} to start`,
        child,
        45_000,
      );
      return action(base);
    },
  );
}

export async function prepareRotation(name: Server): Promise<void> {
  if (name !== "tiding") return;
  const seed = `import {DatabaseService} from "./src/db";
const db = new DatabaseService(process.env.TRMNL_VERIFY_DB);
try {
  const playlist = Number(await db.settings.get("welcome_playlist_id"));
  const original = Number(await db.settings.get("welcome_screen_id"));
  const widget = (await db.widgets.findByScreenDesign(original))[0];
  if (!playlist || !original || !widget) throw new Error("Missing welcome playlist");
  const second = await db.screens.create("TRMNL.Bar rotation", "Verification screen", {width: 800, height: 480});
  await db.widgets.create({...widget, screen_design_id: second,
    config: JSON.stringify({...JSON.parse(widget.config), text: "TRMNL.Bar rotation"})});
  for (const item of await db.playlists.findItems(playlist)) await db.playlists.deleteItem(item.id);
  await db.playlists.addItem({playlist_id: playlist, screen_design_id: original, order: 0, duration: 1});
  await db.playlists.addItem({playlist_id: playlist, screen_design_id: second, order: 1, duration: 1});
} finally { db.close(); }`;
  await run("bun", ["-e", seed], {
    cwd: directory(name),
    env: { ...process.env, TRMNL_VERIFY_DB: join(directory(name), "data/verification.db") },
  });
}
