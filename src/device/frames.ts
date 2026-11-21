import { screen } from "../config.ts";
import type { Host } from "../runtime/host.ts";
import type { Credentials } from "../storage/credentials.ts";
import { cancelled, DeviceError } from "../errors.ts";
import type { Operation } from "../runtime/operation.ts";
import type { DeviceReply, Protocol } from "../protocol/client.ts";
import type { Credential, Frame, State } from "../storage/state.ts";

export class Frames {
  pending?: Frame;
  private verified = "";

  constructor(
    private state: State,
    private host: Pick<Host, "image">,
    private credentials: Credentials,
  ) {}

  reset(): void {
    this.pending = undefined;
    this.verified = "";
    Object.assign(this.state, {
      image: undefined,
      filename: "",
      revision: 0,
      waiting: false,
      nextPollAt: 0,
      retryAt: 0,
    });
  }

  async restore(operation: Operation, force = false): Promise<void> {
    const image = this.state.image;
    if (!image || (!force && this.verified === image.src)) return;
    try {
      this.state.image = await operation.wait(this.host.image.load(image.src));
      this.verified = this.state.image.src;
    } catch (error) {
      operation.check();
      if (cancelled(error)) throw error;
      this.state.image = undefined;
    }
  }

  recover(credential: Credential): void {
    const frame = credential.frame;
    if (
      !this.pending &&
      frame?.model === this.state.model &&
      frame.mode === this.state.mode &&
      (!this.state.image || frame.revision !== this.state.revision)
    )
      this.pending = frame;
  }

  select(reply: DeviceReply, pairing: boolean, credential: Credential): Frame | undefined {
    const unchanged =
      !pairing &&
      this.state.image &&
      (reply.skipUpdate || (reply.filename && reply.filename === this.state.filename));
    if (unchanged || (pairing && !reply.imageURL)) return;
    if (!reply.imageURL) throw new DeviceError("response");
    this.pending = {
      revision: Math.max(this.state.revision, credential.frame?.revision ?? 0) + 1,
      nextPollAt: this.state.nextPollAt,
      mode: this.state.mode,
      model: screen.model,
      imageURL: reply.imageURL,
      filename: reply.filename,
      pairing,
      updateFirmware: reply.updateFirmware,
    };
    return this.pending;
  }

  async load(
    frame: Frame,
    protocol: Protocol,
    credential: Credential,
    operation: Operation,
  ): Promise<Frame> {
    if (
      credential.frame?.revision !== frame.revision ||
      credential.frame.model !== frame.model ||
      credential.frame.mode !== frame.mode
    ) {
      await operation.wait(
        this.credentials.checkpoint(credential, frame, operation),
        "credentials",
      );
    }
    const bytes = await operation.wait(protocol.image(frame.imageURL, credential.token));
    const image = await operation.wait(this.host.image.load(bytes), "image");
    // Recovering the same revision preserves scheduling and enrollment updates from newer replies.
    const applied =
      frame.revision === this.state.revision
        ? {
            ...frame,
            nextPollAt: this.state.nextPollAt,
            pairing: this.state.waiting,
            filename: this.state.filename,
          }
        : { ...frame, filename: frame.pairing ? "" : frame.filename };
    Object.assign(this.state, {
      nextPollAt: applied.nextPollAt,
      retryAt: 0,
      image,
      filename: applied.filename,
      revision: applied.revision,
    });
    this.verified = image.src;
    this.pending = undefined;
    return applied;
  }
}
