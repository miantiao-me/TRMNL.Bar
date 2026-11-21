import { Device } from "./device/controller.ts";
import { virtualDeviceId } from "./config.ts";
import type { Env } from "./runtime/host.ts";
import { renderDevice } from "./ui/view.ts";

const device = new Device({
  host: $metrix,
  storage: localStorage,
  request: fetch,
  now: Date.now,
  makeId: virtualDeviceId,
});

let language: string | undefined;

export default {
  async event(name: string, payload?: { type?: string }) {
    if (
      name === "lifecycle" &&
      payload?.type === "start" &&
      (await $metrix.caniuse("app.locale"))
    ) {
      language = await $metrix.system("app.locale");
    }
  },
  scheduled: (env: Env) => device.scheduled(env),
  render: (env: Env) =>
    renderDevice(device, {
      trayIcon: env.inputs.tray_icon,
      platform: $metrix.platform,
      language,
    }),
};
