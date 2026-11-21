import type { Env, ManagedImage, Runtime } from "../runtime/host.ts";
import { configuration, screen, type Configuration } from "../config.ts";
import { cancelled, DeviceError, failure } from "../errors.ts";
import { Credentials } from "../storage/credentials.ts";
import { Operation } from "../runtime/operation.ts";
import { Enrollment } from "./enrollment.ts";
import { Protocol, type DeviceReply } from "../protocol/client.ts";
import { Frames } from "./frames.ts";
import { restore, stateKey, type Credential, type Frame, type State } from "../storage/state.ts";
import { sendDiagnostic, type Diagnostic } from "./diagnostics.ts";

type Action = "refresh" | "pair" | "connect";
export type DeviceStatus =
  | { phase: "ready" | "pairing" | "empty"; updateFirmware?: boolean }
  | { phase: "loading" | "unconfigured" | "disconnecting" | "disconnected" }
  | { phase: "error"; error: DeviceError; diagnostic?: Diagnostic };

function screenStatus(
  mode: State["mode"],
  waiting: boolean,
  updateFirmware?: boolean,
): DeviceStatus {
  return { phase: waiting ? (mode === "mirror" ? "empty" : "pairing") : "ready", updateFirmware };
}

function initialStatus(state: State): DeviceStatus {
  if (state.connection !== "connected") return { phase: state.connection };
  if (state.needsToken) return { phase: "error", error: new DeviceError("authentication") };
  if (state.waiting || state.image) return screenStatus(state.mode, state.waiting);
  return { phase: "loading" };
}

export class Device {
  private state: State;
  private credentials: Credentials;
  private frames: Frames;
  private enrollment: Enrollment;
  private current?: Configuration;
  private action?: Action;
  private active?: Operation;
  private diagnostic?: Operation;
  status: DeviceStatus;

  constructor(private runtime: Runtime) {
    this.state = restore(runtime.storage, runtime.makeId);
    this.credentials = new Credentials(runtime.host, runtime.storage);
    this.frames = new Frames(this.state, runtime.host, this.credentials);
    this.enrollment = new Enrollment(runtime);
    this.status = initialStatus(this.state);
  }

  get image(): ManagedImage | undefined {
    return this.disconnected ? undefined : this.state.image;
  }
  get id(): string {
    return this.current?.id ?? this.state.generatedId;
  }
  get mode(): Configuration["mode"] {
    return this.current?.mode ?? this.state.mode;
  }
  get disconnected(): boolean {
    return this.state.connection !== "connected";
  }
  get canConnect(): boolean {
    return this.state.connection === "disconnected";
  }
  get friendlyId(): string {
    return this.state.friendlyId;
  }
  get phase(): DeviceStatus["phase"] {
    return this.status.phase;
  }
  get lastFailure() {
    return this.status.phase === "error" ? this.status.error.code : undefined;
  }
  get canSendDiagnostic(): boolean {
    return Boolean(
      this.current && this.mode === "device" && !this.disconnected && this.lastFailure,
    );
  }

  private save(): void {
    this.runtime.storage.setItem(stateKey, JSON.stringify(this.state));
  }

  private schedule(delay: number): void {
    this.runtime.host.schedule(Math.min(86_400_000, Math.max(1000, Math.round(delay))));
  }

  private configure(inputs: Env["inputs"]): Configuration {
    this.current = undefined;
    const config = configuration(inputs, this.state.generatedId);
    const bindingChanged = this.state.binding !== config.binding;
    const modeChanged = this.state.mode !== config.mode;
    if ((bindingChanged || modeChanged) && this.action === "pair") this.action = "refresh";
    if (bindingChanged || modeChanged || this.state.model !== screen.model) {
      this.enrollment.cancel();
      this.frames.reset();
      this.state.binding = config.binding;
      this.state.mode = config.mode;
      this.state.model = screen.model;
      this.state.needsToken = false;
      if (bindingChanged) this.state.friendlyId = "";
      this.status = { phase: "loading" };
      this.save();
    }
    this.current = config;
    return config;
  }

  private async cleanDisconnect(operation: Operation): Promise<void> {
    await operation.wait(this.credentials.clear(operation));
    this.frames.reset();
    this.state.friendlyId = "";
    this.state.needsToken = false;
    this.state.connection = "disconnected";
    this.status = { phase: "disconnected" };
    this.save();
  }

  private async showFrame(
    frame: Frame,
    protocol: Protocol,
    credential: Credential,
    operation: Operation,
  ): Promise<void> {
    const applied = await operation.wait(this.frames.load(frame, protocol, credential, operation));
    this.publish(applied.pairing, applied.updateFirmware);
  }

  private publish(waiting: boolean, updateFirmware: boolean): void {
    this.state.waiting = waiting;
    this.status = screenStatus(this.mode, waiting, updateFirmware);
    this.save();
    this.schedule(this.state.nextPollAt - this.runtime.now());
  }

  private async accept(
    reply: DeviceReply,
    protocol: Protocol,
    credential: Credential,
    operation: Operation,
    waiting = reply.status === "waiting",
  ): Promise<void> {
    this.state.friendlyId = reply.friendlyId || this.state.friendlyId;
    this.state.nextPollAt = this.runtime.now() + reply.refreshDelay;
    this.state.waiting = waiting;
    const frame = this.frames.select(reply, waiting, credential);
    if (frame) await this.showFrame(frame, protocol, credential, operation);
    else this.publish(waiting, reply.updateFirmware);
  }

  async scheduled(env: Env): Promise<void> {
    this.cancelWork();
    const operation = new Operation();
    this.active = operation;
    try {
      if (this.state.connection === "disconnecting")
        await operation.wait(this.cleanDisconnect(operation));
      if (this.disconnected && this.action !== "connect") {
        this.runtime.host.schedule(null);
        return;
      }
      const config = this.configure(env.inputs);
      if (this.disconnected) {
        this.state.connection = "connected";
        this.status = { phase: "loading" };
        this.save();
      }
      await this.poll(env.reason, config, operation);
    } catch (error) {
      if (!cancelled(error) && this.active === operation)
        await this.handleFailure(error, operation);
    } finally {
      operation.close();
      if (this.active === operation) this.active = undefined;
    }
  }

  private async poll(reason: string, config: Configuration, operation: Operation): Promise<void> {
    const requested =
      this.action !== undefined || reason === "manual" || reason === "inputs-changed";
    if (this.state.needsToken && !requested) {
      this.runtime.host.schedule(null);
      return;
    }
    if (
      !(await operation.wait(this.runtime.host.caniuse("image.load"))) ||
      !(await operation.wait(this.runtime.host.caniuse("setSecret")))
    )
      throw new DeviceError("unsupported");

    if (this.action === "pair") await operation.wait(this.clearPairing(operation));
    let credential = await operation.wait(this.credentials.read(config.binding, operation));
    const cacheMissing = reason === "cache-missing";
    await operation.wait(this.frames.restore(operation, cacheMissing));
    this.action = undefined;
    this.state.needsToken = false;
    if (!credential.token && config.mode === "mirror") {
      this.frames.pending = undefined;
      this.state.waiting = false;
      this.status = { phase: "unconfigured" };
      this.save();
      this.runtime.host.schedule(null);
      return;
    }
    this.frames.recover(credential);
    const force = requested || cacheMissing;
    const now = this.runtime.now();
    if (!force && now < this.state.retryAt) {
      this.schedule(this.state.retryAt - now);
      return;
    }
    const protocol = new Protocol(config, this.runtime.request, this.runtime.now, operation.signal);
    if (this.frames.pending) {
      await this.showFrame(this.frames.pending, protocol, credential, operation);
      return;
    }
    if (!force && (this.state.image || this.state.waiting) && now < this.state.nextPollAt) {
      this.schedule(this.state.nextPollAt - now);
      return;
    }
    this.state.retryAt = 0;
    if (!credential.token) {
      const paired = await operation.wait(
        this.enrollment.pair(config, credential, this.credentials, operation),
      );
      credential = paired.credential;
      if (!credential.token || paired.reply.status === "waiting") {
        await this.accept(paired.reply, protocol, credential, operation, true);
        return;
      }
      this.state.friendlyId = paired.reply.friendlyId || this.state.friendlyId;
    } else {
      this.enrollment.cancel();
    }
    const reply = await operation.wait(
      config.mode === "mirror"
        ? protocol.mirror(credential.token)
        : protocol.display(credential.token),
    );
    await this.accept(reply, protocol, credential, operation);
  }

  private async clearPairing(operation: Operation): Promise<void> {
    await operation.wait(this.credentials.clear(operation));
    this.frames.pending = undefined;
    this.state.friendlyId = "";
    this.state.nextPollAt = 0;
    this.state.retryAt = 0;
  }

  private async handleFailure(error: unknown, operation: Operation): Promise<void> {
    let problem = failure(error, "network");
    if (problem.code === "registration") {
      try {
        await operation.wait(this.clearPairing(operation));
      } catch (storageError) {
        if (cancelled(storageError)) return;
        problem = failure(storageError, "credentials");
      }
    }
    if (problem.code === "no-screen") {
      this.state.waiting = true;
      this.status = { phase: "empty" };
    } else {
      this.status = { phase: "error", error: problem };
    }
    this.state.needsToken = problem.code === "authentication";
    this.state.retryAt = this.runtime.now() + problem.retryAfter;
    if (!this.frames.pending) this.state.nextPollAt = this.state.retryAt;
    this.save();
    if (problem.code === "authentication") this.runtime.host.schedule(null);
    else if (problem.code !== "unsupported") this.schedule(problem.retryAfter);
  }

  async sendLog(): Promise<void> {
    const { status, current } = this;
    if (status.phase !== "error" || current?.mode !== "device" || this.disconnected) return;
    this.diagnostic?.cancel();
    const operation = new Operation();
    this.diagnostic = operation;
    const diagnostic = await sendDiagnostic(
      this.runtime,
      this.credentials,
      current,
      status.error.code,
      operation,
    );
    if (this.diagnostic !== operation) return;
    this.diagnostic = undefined;
    if (this.status === status) {
      this.status = { ...status, diagnostic };
      this.runtime.host.invalidate();
    }
  }

  refresh(): void {
    if (!this.disconnected) this.request("refresh");
  }
  pairAgain(): void {
    if (this.mode !== "device" || this.disconnected) return;
    this.enrollment.cancel();
    this.request("pair");
  }
  disconnect(): void {
    if (this.state.connection === "disconnected") return;
    this.state.connection = "disconnecting";
    this.status = { phase: "disconnecting" };
    this.action = undefined;
    this.save();
    this.enrollment.cancel();
    this.cancelWork();
    this.schedule(1000);
    this.runtime.host.invalidate();
  }
  connect(): void {
    if (this.canConnect) this.request("connect");
  }
  openServer(): void {
    const server = this.current?.server ?? "https://trmnl.com/";
    const path = this.mode === "mirror" ? "devices" : "start";
    this.runtime.host.openURL(
      new URL(server).origin === "https://trmnl.com" ? `https://trmnl.com/${path}` : server,
    );
  }
  private request(action: Action): void {
    this.cancelWork();
    if (this.action !== "pair") this.action = action;
    this.schedule(1000);
  }
  private cancelWork(): void {
    this.active?.cancel();
    this.diagnostic?.cancel();
    this.diagnostic = undefined;
  }
}
