import { dashboardIcon, screen } from "../config.ts";
import type { Device } from "../device/controller.ts";
import { messagesFor, statusMessage, type Messages } from "./messages.ts";

type MenuItem =
  | { label: string; onClick: () => void | Promise<void> }
  | { label: string; disabled: true }
  | { separator: true };

const iconifyName = /^(?:iconify:)?[a-z0-9-]+:[a-z0-9-]+$/;

function actions(device: Device, labels: Messages["actions"]): MenuItem[] {
  const server = { label: labels.server, onClick: () => device.openServer() };
  if (device.phase === "disconnecting") return [server];
  if (device.disconnected) {
    return [
      device.canConnect
        ? { label: labels.connect, onClick: () => device.connect() }
        : { label: labels.retryDisconnect, onClick: () => device.disconnect() },
      server,
    ];
  }
  return [
    // The host uses this label to replace and localize its built-in refresh action.
    { label: "Refresh", onClick: () => device.refresh() },
    ...(device.mode === "device"
      ? [{ label: labels.pair, onClick: () => device.pairAgain() }]
      : []),
    server,
    { label: labels.disconnect, onClick: () => device.disconnect() },
    ...(device.canSendDiagnostic
      ? [{ label: labels.diagnose, onClick: () => device.sendLog() }]
      : []),
  ];
}

export function renderDevice(
  device: Device,
  {
    trayIcon,
    platform,
    language,
  }: { trayIcon?: unknown; platform?: string; language?: string } = {},
) {
  const icon = typeof trayIcon === "string" ? trayIcon.trim() : "";
  const title = icon && !iconifyName.test(icon) ? icon : "";
  const image = device.image;
  const { width, height } = screen;
  const messages = messagesFor(language);
  const message = statusMessage(device.status, messages);
  const pairing = device.phase === "pairing" || device.lastFailure === "registration";
  const details = [
    message,
    ...(pairing ? [messages.deviceId(device.id)] : []),
    ...(pairing && device.friendlyId ? [messages.pairingCode(device.friendlyId)] : []),
  ].filter(Boolean);
  const menu = actions(device, messages.actions);
  if (details.length) {
    menu.push({ separator: true }, ...details.map((label) => ({ label, disabled: true as const })));
  }
  const widget = image ? { type: "Image", props: { src: image.src } } : { type: "Spacer" };
  return {
    tray: {
      ...(title
        ? { title, icon: platform === "darwin" ? null : dashboardIcon }
        : { icon: icon || dashboardIcon }),
      iconTemplate: true,
      menu,
    },
    panel: {
      type: "Column",
      props: {
        preferredWidth: width,
        preferredHeight: height,
        fill: true,
        safeArea: true,
        clip: true,
      },
      children: image
        ? [
            {
              type: "Image",
              props: {
                src: image.src,
                width,
                height,
                fit: "contain",
                absolute: true,
                left: "50%",
                top: "50%",
                marginLeft: -width / 2,
                marginTop: -height / 2,
              },
            },
          ]
        : [],
    },
    widget: { small: widget, medium: widget, large: widget },
  };
}
