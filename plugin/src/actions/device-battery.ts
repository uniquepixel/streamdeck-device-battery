import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyAction,
  SingletonAction,
  WillAppearEvent,
} from "@elgato/streamdeck";
import WebSocket from "ws"; // Node.js WebSocket client

type DeviceId = "hyperx" | "switchpro" | "g502";

/** Options configurable from the Property Inspector. */
type BatterySettings = {
  device?: DeviceId;
  showPercent?: boolean;
  warnThreshold?: number;
};

/** Per-device state as reported by the background service. */
type DeviceState =
  | { connected: false }
  | { connected: true; value: number; charging: boolean };

const WS_URL = "ws://localhost:3100";
const DEFAULT_DEVICE: DeviceId = "hyperx";
const MAX_BACKOFF_MS = 15000;

// ---------------------------------------------------------------------------
// Shared feed: ONE WebSocket for all keys, with auto-reconnect. It caches the
// latest state of every device and notifies the action on any change, so the
// service can start before or after the plugin and a restart is recovered.
// ---------------------------------------------------------------------------
let socket: WebSocket | undefined;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let devices: Record<string, DeviceState> = {};
let devicesKey = "";
const listeners = new Set<() => void>();

function stateKey(s: DeviceState): string {
  return s.connected ? `on:${s.value}:${s.charging}` : "off";
}

function snapshotKey(map: Record<string, DeviceState>): string {
  return Object.keys(map).sort().map(id => `${id}=${stateKey(map[id])}`).join("|");
}

/** Adopt a new snapshot and notify only on a real change (no 1 s redraw). */
function applySnapshot(next: Record<string, DeviceState>): void {
  const key = snapshotKey(next);
  if (key === devicesKey) return;
  devices = next;
  devicesKey = key;
  for (const notify of listeners) notify();
}

function deviceState(id: DeviceId): DeviceState {
  return devices[id] ?? { connected: false };
}

function connectFeed(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = 1000;
  };

  ws.onmessage = (event) => {
    try {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      const data = JSON.parse(raw);
      if (data?.type !== "devices" || typeof data.devices !== "object") return;

      const next: Record<string, DeviceState> = {};
      for (const [id, d] of Object.entries<any>(data.devices)) {
        next[id] = (d?.connected === true && typeof d.value === "number")
          ? { connected: true, value: d.value, charging: !!d.charging }
          : { connected: false };
      }
      applySnapshot(next);
    } catch (error) {
      streamDeck.logger.error("Battery feed: failed to handle message", error);
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = undefined;
    applySnapshot({});
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose follows and handles the reconnect.
    try { ws.close(); } catch { /* ignore */ }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectFeed();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Icon rendering: a dynamic SVG based on level / charging / connection.
// ---------------------------------------------------------------------------
function svgFrame(size: number, inner: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="#1e1e1e"/>${inner}</svg>`
  );
}

function renderBatteryIcon(state: DeviceState, warn: number, showPercent: boolean): string {
  const W = 144;
  const bodyX = 29, bodyY = 28, bodyW = 78, bodyH = 46, r = 9;
  const capW = 7, capH = 22, capX = bodyX + bodyW, capY = bodyY + (bodyH - capH) / 2;

  if (!state.connected) {
    return svgFrame(
      W,
      `<rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="${r}" fill="none" stroke="#666" stroke-width="5"/>` +
        `<rect x="${capX}" y="${capY}" width="${capW}" height="${capH}" rx="3" fill="#666"/>` +
        `<text x="${bodyX + bodyW / 2}" y="${bodyY + bodyH / 2}" font-family="Arial, sans-serif" font-size="30" font-weight="bold" fill="#888" text-anchor="middle" dominant-baseline="central">?</text>`,
    );
  }

  const level = Math.max(0, Math.min(100, Math.round(state.value)));
  const color = level <= warn ? "#e74c3c" : level <= 50 ? "#f1c40f" : "#2ecc71";
  const pad = 7;
  const innerX = bodyX + pad, innerY = bodyY + pad;
  const innerW = bodyW - pad * 2, innerH = bodyH - pad * 2;
  const fillW = Math.round((innerW * level) / 100);

  const bolt = state.charging
    ? `<path d="M70 32 L56 55 L65 55 L62 72 L80 49 L70 49 Z" fill="#ffffff" stroke="#1e1e1e" stroke-width="2" stroke-linejoin="round"/>`
    : "";

  const label = showPercent
    ? `<text x="72" y="112" font-family="Arial, sans-serif" font-size="34" font-weight="bold" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${level}%</text>`
    : "";

  return svgFrame(
    W,
    `<rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="${r}" fill="none" stroke="#cccccc" stroke-width="5"/>` +
      `<rect x="${capX}" y="${capY}" width="${capW}" height="${capH}" rx="3" fill="#cccccc"/>` +
      `<rect x="${innerX}" y="${innerY}" width="${fillW}" height="${innerH}" rx="3" fill="${color}"/>` +
      bolt +
      label,
  );
}

function resolveDevice(settings: BatterySettings): DeviceId {
  return settings.device ?? DEFAULT_DEVICE;
}

function clampWarn(v: number | undefined, device: DeviceId): number {
  // The Switch Pro reports only coarse levels (100/75/50/25/5), so default its
  // warning a bit higher so "critical" (25 %) shows red.
  const fallback = device === "switchpro" ? 30 : 20;
  if (typeof v !== "number" || Number.isNaN(v)) return fallback;
  return Math.max(0, Math.min(100, v));
}

@action({ UUID: "com.pixel.devicebattery.battery" })
export class DeviceBatteryAction extends SingletonAction<BatterySettings> {
  constructor() {
    super();
    // On every feed change, redraw all visible keys.
    listeners.add(() => void this.renderAll());
  }

  override onWillAppear(ev: WillAppearEvent<BatterySettings>): void | Promise<void> {
    connectFeed();
    if (ev.action.isKey()) {
      return this.render(ev.action, ev.payload.settings ?? {});
    }
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<BatterySettings>): void | Promise<void> {
    if (ev.action.isKey()) {
      return this.render(ev.action, ev.payload.settings ?? {});
    }
  }

  private async renderAll(): Promise<void> {
    for (const a of this.actions) {
      if (a.isKey()) {
        const settings = await a.getSettings();
        await this.render(a, settings);
      }
    }
  }

  private async render(action: KeyAction<BatterySettings>, settings: BatterySettings): Promise<void> {
    const device = resolveDevice(settings);
    const showPercent = settings.showPercent ?? true;
    const warn = clampWarn(settings.warnThreshold, device);
    const svg = renderBatteryIcon(deviceState(device), warn, showPercent);
    await action.setImage("data:image/svg+xml;charset=utf8," + encodeURIComponent(svg));
    // Clear the title so no leftover text title remains (the % is drawn in the icon).
    await action.setTitle("");
  }
}
