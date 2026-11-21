import type { Configuration } from "../config.ts";
import type { Credentials } from "../storage/credentials.ts";
import type { Runtime } from "../runtime/host.ts";
import { Operation } from "../runtime/operation.ts";
import { Protocol } from "../protocol/client.ts";
import type { Credential } from "../storage/state.ts";

export class Enrollment {
  private pending?: { operation: Operation; reply: ReturnType<Protocol["setup"]> };

  constructor(private runtime: Pick<Runtime, "request" | "now">) {}

  private start(config: Configuration) {
    // A scheduled refresh can be superseded while the server issues a one-time token.
    const operation = new Operation();
    const protocol = new Protocol(config, this.runtime.request, this.runtime.now, operation.signal);
    return { operation, reply: operation.wait(protocol.setup()).finally(() => operation.close()) };
  }

  async pair(
    config: Configuration,
    credential: Credential,
    credentials: Credentials,
    operation: Operation,
  ) {
    const pending = (this.pending ??= this.start(config));
    let reply: Awaited<typeof pending.reply>;
    try {
      reply = await operation.wait(pending.reply);
    } catch (error) {
      if (!operation.signal.aborted) this.pending = undefined;
      throw error;
    }
    if (reply.apiKey) {
      credential = await operation.wait(credentials.save(config.binding, reply.apiKey, operation));
    }
    this.pending = undefined;
    return { credential, reply };
  }

  cancel(): void {
    this.pending?.operation.cancel();
    this.pending = undefined;
  }
}
