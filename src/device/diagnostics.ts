import type { Configuration } from "../config.ts";
import type { Credentials } from "../storage/credentials.ts";
import type { FailureCode } from "../errors.ts";
import type { Runtime } from "../runtime/host.ts";
import type { Operation } from "../runtime/operation.ts";
import { Protocol } from "../protocol/client.ts";

export type Diagnostic = "sent" | "failed" | "unavailable";

export async function sendDiagnostic(
  runtime: Pick<Runtime, "request" | "now">,
  credentials: Credentials,
  config: Configuration,
  code: FailureCode,
  operation: Operation,
): Promise<Diagnostic> {
  try {
    const credential = await operation.wait(credentials.read(config.binding, operation));
    if (!credential.token) return "unavailable";
    await operation.wait(
      new Protocol(config, runtime.request, runtime.now, operation.signal).log(
        credential.token,
        code,
      ),
    );
    return "sent";
  } catch {
    // Keep the original error visible if diagnostics fail.
    return "failed";
  } finally {
    operation.close();
  }
}
