import * as v from "valibot";
import type { Host } from "../runtime/host.ts";
import { DeviceError } from "../errors.ts";
import { frameKey, newKey, open, seal } from "./checkpoint.ts";
import type { Operation } from "../runtime/operation.ts";
import {
  credentialKind,
  credentialSchema,
  parseJSON,
  type Credential,
  type Frame,
} from "./state.ts";

export class Credentials {
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private host: Pick<Host, "secret" | "setSecret" | "deleteSecret">,
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  ) {}

  async read(binding: string, operation: Operation): Promise<Credential> {
    await operation.wait(this.writing);
    const raw = this.raw().trim();
    const value = parseJSON(raw);
    const result = v.safeParse(credentialSchema, value);
    if (result.success) {
      const credential = result.output;
      if (credential.binding !== binding) return this.empty(binding);
      return {
        ...credential,
        frame: credential.key
          ? open(this.storage.getItem(frameKey) ?? "", credential.key, binding)
          : undefined,
      };
    }
    if (!raw || v.is(v.object({ kind: v.literal(credentialKind) }), value))
      return this.empty(binding);
    return this.save(binding, raw, operation);
  }

  async save(binding: string, token: string, operation: Operation) {
    if (/[\r\n]/.test(token)) throw new DeviceError("credentials");
    return this.write(async () => {
      const raw = this.raw();
      const current = v.safeParse(credentialSchema, parseJSON(raw));
      const key =
        current.success && current.output.binding === binding ? current.output.key : undefined;
      const credential = { kind: credentialKind, binding, token, key: key ?? newKey() } as const;
      const encoded = JSON.stringify(credential);
      if (raw !== encoded) await this.host.setSecret("access_token", encoded);
      return credential;
    }, operation);
  }

  async checkpoint(credential: Credential, frame: Frame, operation: Operation): Promise<void> {
    const { binding, token } = credential;
    const key = credential.key ?? (await this.save(binding, token, operation)).key;
    operation.check();
    this.storage.setItem(frameKey, seal(frame, key, binding));
  }

  async clear(operation: Operation): Promise<void> {
    await this.write(async () => {
      await this.host.deleteSecret("access_token");
      operation.check();
      this.storage.removeItem(frameKey);
    }, operation);
  }

  private raw(): string {
    try {
      return this.host.secret("access_token");
    } catch {
      // An unset secret throws, including before the first pairing.
      return "";
    }
  }

  private empty(binding: string): Credential {
    return { kind: credentialKind, binding, token: "" };
  }

  private write<T>(action: () => Promise<T>, operation: Operation): Promise<T> {
    const task = this.writing.then(() => {
      operation.check();
      return action();
    });
    this.writing = task.catch(() => {});
    return operation.wait(task, "credentials");
  }
}
