import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TreeNode {
  id: string;
  key?: string;
  label?: string;
  actions?: string[];
  bounds: Rectangle;
}

interface WindowInfo {
  id: number;
  visible: boolean;
  kind: string;
  focused: boolean;
  contentBounds: Rectangle;
}

interface Replies {
  windows: { windows: WindowInfo[] };
  tree: { nodes: TreeNode[] };
  capture: { png: string };
  idle: unknown;
  act: unknown;
}

export class Automation {
  private sequence = 0;
  private capturedAt = new Map<number, number>();
  private lines;

  private constructor(private socket: Socket) {
    this.lines = createInterface({ input: socket });
  }

  static async connect(path: string): Promise<Automation> {
    const socket = createConnection(path);
    await once(socket, "connect");
    return new Automation(socket);
  }

  close(): void {
    this.lines.close();
    this.socket.destroy();
  }

  async call<M extends keyof Replies>(method: M, params: object = {}): Promise<Replies[M]> {
    const id = ++this.sequence;
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Automation request timed out (${method})`)),
        15_000,
      );
      const receive = (line: string) => finish(undefined, line);
      const close = () => finish(new Error(`Automation connection closed (${method})`));
      const finish = (error?: Error | null, line = "") => {
        clearTimeout(timer);
        this.lines.off("line", receive).off("close", close).off("error", finish);
        if (error) reject(error);
        else resolve(line);
      };
      this.lines.once("line", receive).once("close", close).once("error", finish);
      this.socket.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) finish(error);
      });
    });
    const reply = JSON.parse(line) as { id: number; result: Replies[M]; error?: unknown };
    assert.equal(reply.id, id, `Unexpected automation response ID (${method})`);
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }

  async tree(window: number): Promise<Replies["tree"]> {
    // Draw a frame to update the preview tree when the window is obscured.
    if (performance.now() - (this.capturedAt.get(window) ?? -Infinity) >= 250) {
      await this.call("capture", { window });
      this.capturedAt.set(window, performance.now());
    }
    return this.call("tree", { window });
  }

  async press(window: number, key: string): Promise<void> {
    await this.call("act", { window, key, action: "press" });
  }
}
