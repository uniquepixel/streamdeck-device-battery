import HID from 'node-hid';

// === HyperX Cloud III Wireless ===============================================
// Each report is 62 bytes and starts with byte[0] = 102. byte[1] is the type:
//   12 -> charging state: byte[2] = 1 (charging) / 0 (on battery)
//   13 -> battery state:  byte[4] = charge level in %  (0 => headset off)
//   11 -> headset was powered off
//   other (e.g. 0x8x) -> radio handshake on power-on, ignored
const VENDOR_ID = 0x03F0;
const PRODUCT_ID = 0x05B7;
const USAGE_PAGE = 65299;

const REPORT_HEADER = 102;
const TYPE_CHARGING = 12;
const TYPE_BATTERY = 13;
const TYPE_POWER_OFF = 11;

// On power-on there are brief "11/0" reports during the radio handshake. An
// "off" is therefore only honoured if no valid battery report arrived recently.
const OFF_DEBOUNCE_MS = 2000;
const RECONNECT_INTERVAL_MS = 3000;

export function createHyperXReader() {
  let device = null;
  let lastBatteryLevel = -1;
  let lastCharging = false;
  let headsetOn = false;
  let lastBatteryAt = 0;

  function markOff() {
    if (Date.now() - lastBatteryAt > OFF_DEBOUNCE_MS) headsetOn = false;
  }

  function handleReport(d) {
    if (d[0] !== REPORT_HEADER) return;
    switch (d[1]) {
      case TYPE_CHARGING:
        lastCharging = d[2] === 1;
        break;
      case TYPE_BATTERY:
        if (d[4] > 0) {
          lastBatteryLevel = d[4];
          lastBatteryAt = Date.now();
          headsetOn = true;
        } else {
          markOff();
        }
        break;
      case TYPE_POWER_OFF:
        markOff();
        break;
      // other types: radio handshake / misc -> ignore
    }
  }

  function closeDevice() {
    if (device) {
      try { device.close(); } catch { /* ignore */ }
    }
    device = null;
  }

  function connect() {
    const info = HID.devices().find(d =>
      d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID && d.usagePage === USAGE_PAGE);
    if (!info) return;
    try {
      device = new HID.HID(info.path);
    } catch {
      device = null;
      return;
    }
    console.log('[hyperx] connected:', info.product || info.path);
    device.on('data', data => handleReport([...data]));
    device.on('error', () => { closeDevice(); });
  }

  return {
    id: 'hyperx',
    name: 'HyperX Cloud 3',
    start() {
      connect();
      setInterval(() => { if (!device) connect(); }, RECONNECT_INTERVAL_MS);
    },
    getState() {
      if (!device || !headsetOn || lastBatteryLevel < 0) return { connected: false };
      return { connected: true, value: lastBatteryLevel, charging: lastCharging };
    },
  };
}
