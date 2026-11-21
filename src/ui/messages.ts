import type { DeviceStatus } from "../device/controller.ts";
import type { FailureCode } from "../errors.ts";

const english = {
  actions: {
    server: "Open TRMNL server",
    connect: "Connect",
    retryDisconnect: "Retry disconnect",
    pair: "Pair again",
    disconnect: "Disconnect",
    diagnose: "Send diagnostics",
  },
  status: {
    loading: "Connecting…",
    unconfigured: "Enter a device token",
    empty: "No screen yet",
    disconnecting: "Disconnecting…",
    disconnected: "Disconnected",
    pairing: "Register the device",
  },
  errors: {
    configuration: "Check dashboard settings",
    unsupported: "Device features are unavailable",
    authentication: "Update the device token",
    registration: "Pair the device again",
    credentials: "Unable to save device credentials",
    timeout: "Refresh timed out",
    image: "Unable to load screen",
    response: "Invalid server response",
    "rate-limit": "Too many requests",
    network: "Unable to connect to the server",
  } satisfies Partial<Record<FailureCode, string>>,
  diagnostics: {
    sent: "Diagnostics sent",
    failed: "Unable to send diagnostics",
    unavailable: "Pair the device to send diagnostics",
  },
  firmware: "No firmware update needed",
  allowImageOrigin: (origin: string) => `Allow image access from ${origin}`,
  deviceId: (id: string) => `Device ID ${id}`,
  pairingCode: (code: string) => `Pairing code ${code}`,
};

export type Messages = typeof english;

const simplifiedChinese: Messages = {
  actions: {
    server: "打开服务端",
    connect: "连接",
    retryDisconnect: "重试断开",
    pair: "重新配对",
    disconnect: "断开连接",
    diagnose: "发送诊断",
  },
  status: {
    loading: "正在连接…",
    unconfigured: "请填写设备令牌",
    empty: "暂无画面",
    disconnecting: "正在断开…",
    disconnected: "已断开连接",
    pairing: "请登记设备",
  },
  errors: {
    configuration: "请检查看板设置",
    unsupported: "当前环境无法使用设备能力",
    authentication: "请更新设备令牌",
    registration: "需要重新配对",
    credentials: "无法保存设备凭据",
    timeout: "刷新超时",
    image: "无法获取画面",
    response: "服务端响应无效",
    "rate-limit": "请求过于频繁",
    network: "无法连接服务端",
  },
  diagnostics: {
    sent: "诊断已发送",
    failed: "诊断发送失败",
    unavailable: "配对后才能发送诊断",
  },
  firmware: "无需更新固件",
  allowImageOrigin: (origin) => `请授权图片来源 ${origin}`,
  deviceId: (id) => `设备 ID ${id}`,
  pairingCode: (code) => `配对码 ${code}`,
};

export function messagesFor(language?: string): Messages {
  return language && /^zh(?:$|-(?:hans|cn|sg)(?:-|$))/i.test(language)
    ? simplifiedChinese
    : english;
}

export function statusMessage(status: DeviceStatus, messages = english): string {
  if (status.phase === "error") {
    const errors: Partial<Record<FailureCode, string>> = messages.errors;
    const text =
      status.error.code === "image-origin"
        ? messages.allowImageOrigin(status.error.origin)
        : (errors[status.error.code] ?? messages.errors.network);
    return status.diagnostic ? `${text} · ${messages.diagnostics[status.diagnostic]}` : text;
  }
  if (status.phase === "ready") return status.updateFirmware ? messages.firmware : "";
  return messages.status[status.phase];
}
