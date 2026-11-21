import { failure, type FailureCode } from "../errors.ts";

export class Operation {
  private controller = new AbortController();
  readonly signal = this.controller.signal;
  private aborted = new Promise<never>((_, reject) => {
    this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true });
  });
  private timer = setTimeout(
    () => this.controller.abort(new DOMException("Timed out", "TimeoutError")),
    12_000,
  );

  check(): void {
    this.signal.throwIfAborted();
  }
  cancel(): void {
    this.controller.abort();
  }
  close(): void {
    clearTimeout(this.timer);
  }

  async wait<T>(task: Promise<T>, code?: FailureCode): Promise<T> {
    try {
      return await Promise.race([task, this.aborted]);
    } catch (error) {
      throw code ? failure(error, code) : error;
    } finally {
      this.check();
    }
  }
}
