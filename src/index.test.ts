import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { env, fixture } from "./testing/device.ts";

async function worker(locale?: string) {
  vi.resetModules();
  const { runtime } = fixture();
  const system = vi.fn(async () => locale ?? "");
  vi.stubGlobal("$metrix", {
    ...runtime.host,
    caniuse: async () => locale !== undefined,
    system,
  });
  vi.stubGlobal("localStorage", runtime.storage);
  vi.stubGlobal("fetch", runtime.request);
  const { default: dashboard } = await import("./index.ts");
  return { dashboard, system };
}

describe("Dashboard language", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, "en-US", "ja-JP", "zh-Hant-TW"])("Uses English for %s", async (locale) => {
    const { dashboard, system } = await worker(locale);
    await dashboard.event("lifecycle", { type: "start" });
    const view = dashboard.render(env());
    expect(view.tray.menu).toContainEqual({ label: "Connecting…", disabled: true });
    expect(view.tray.menu).toContainEqual({
      label: "Open TRMNL server",
      onClick: expect.any(Function),
    });
    if (locale === undefined) expect(system).not.toHaveBeenCalled();
  });

  it("Uses the host Simplified Chinese locale at startup and keeps it on manual refresh", async () => {
    const { dashboard, system } = await worker("zh-CN");
    expect(dashboard.render(env()).tray.menu).toContainEqual({
      label: "Connecting…",
      disabled: true,
    });
    await dashboard.event("lifecycle", { type: "start" });
    const { tray } = dashboard.render(env());
    expect(tray.menu).toContainEqual({ label: "正在连接…", disabled: true });
    expect(tray.menu).toContainEqual({ label: "重新配对", onClick: expect.any(Function) });
    await dashboard.scheduled(env("manual"));
    expect(dashboard.render(env()).tray.menu).toContainEqual({
      label: "打开服务端",
      onClick: expect.any(Function),
    });
    expect(system).toHaveBeenCalledExactlyOnceWith("app.locale");
  });
});
