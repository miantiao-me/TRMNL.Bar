import { describe, expect, it } from "vite-plus/test";
import { env, fixture, mirrorFixture, mirrorInputs } from "../testing/device.ts";
import { renderDevice } from "./view.ts";

describe("Native panel and menu bar", () => {
  it("Keeps the 800 × 480 panel size from pairing to the first screen", async () => {
    const f = fixture();
    const dimensions = { preferredWidth: 800, preferredHeight: 480 };
    expect(renderDevice(f.device).panel.props).toMatchObject(dimensions);

    f.setSetup({ status: 202, friendly_id: "REGISTER", refresh_rate: 15 });
    await f.device.scheduled(env("initial"));
    const waiting = renderDevice(f.device);
    expect(waiting.panel.props).toMatchObject(dimensions);
    expect(waiting.panel.children).toEqual([]);
    expect(waiting.panel.props).not.toHaveProperty("popoverMenuButton");
    expect(waiting.widget).toEqual({
      small: { type: "Spacer" },
      medium: { type: "Spacer" },
      large: { type: "Spacer" },
    });
    expect(waiting.tray.menu).toContainEqual({ label: "Register the device", disabled: true });
    expect(waiting.tray.menu).toContainEqual({
      label: "Device ID 02:11:22:33:44:55",
      disabled: true,
    });
    expect(waiting.tray.menu).toContainEqual({ label: "Pairing code REGISTER", disabled: true });

    f.advance(15_000);
    f.setSetup({ status: 200, api_key: "paired-key" });
    await f.device.scheduled(env("interval"));
    const ready = renderDevice(f.device);
    expect(ready.panel.props).toMatchObject(dimensions);
    expect(ready.panel.children).toMatchObject([
      {
        type: "Image",
        props: { src: f.device.image?.src, width: 800, height: 480, fit: "contain" },
      },
    ]);
    expect(ready.tray).toMatchObject({ icon: "lucide:monitor", iconTemplate: true });
    expect(ready.widget.small).toEqual({ type: "Image", props: { src: f.device.image?.src } });
  });

  it("Shows an Iconify icon or a native title in the menu bar", () => {
    const { device } = fixture();
    expect(renderDevice(device, { trayIcon: "  " }).tray).toMatchObject({
      icon: "lucide:monitor",
      iconTemplate: true,
    });
    for (const name of ["mdi:monitor", "iconify:lucide:monitor"]) {
      expect(renderDevice(device, { trayIcon: ` ${name} ` }).tray).toMatchObject({
        icon: name,
        iconTemplate: true,
      });
    }
    for (const title of ["👩‍💻", "◈", "TRMNL Deck"]) {
      expect(renderDevice(device, { trayIcon: title, platform: "darwin" }).tray).toMatchObject({
        title,
        icon: null,
      });
      for (const platform of ["windows", "linux"]) {
        expect(renderDevice(device, { trayIcon: title, platform }).tray).toMatchObject({
          title,
          icon: "lucide:monitor",
        });
      }
    }
  });

  it("Offers a server link and omits device pairing and diagnostics in mirror mode", async () => {
    const f = mirrorFixture();
    await f.device.scheduled(env("initial", { ...mirrorInputs, server: "https://trmnl.com" }));
    f.device.openServer();
    expect(f.opened).toEqual(["https://trmnl.com/devices"]);
    const { panel, tray } = renderDevice(f.device);
    expect(panel.children.map(({ type }) => type)).toEqual(["Image"]);
    expect(tray.menu.flatMap((item) => ("label" in item ? [item.label] : []))).toEqual([
      "Refresh",
      "Open TRMNL server",
      "Disconnect",
    ]);
    expect(JSON.stringify({ panel, tray })).not.toContain("mirror-device-key");
  });

  it("Reports download failures in the menu bar and keeps the last screen in the panel and widgets", async () => {
    const f = fixture();
    await f.device.scheduled(env("initial"));
    const ready = renderDevice(f.device);
    f.setDisplay({ status: 0, image_url: "failed.bmp", filename: "failed" });
    f.failImages(1);
    await f.device.scheduled(env("manual"));
    const failed = renderDevice(f.device);
    expect(failed.panel).toEqual(ready.panel);
    expect(failed.widget).toEqual(ready.widget);
    expect(failed.tray).not.toHaveProperty("tooltip");
    expect(failed.tray.menu).toContainEqual({ label: "Unable to load screen", disabled: true });
    expect(failed.tray.menu).toContainEqual({
      label: "Send diagnostics",
      onClick: expect.any(Function),
    });
  });
});
