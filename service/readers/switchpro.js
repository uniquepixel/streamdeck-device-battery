import HID from 'node-hid';

// === Nintendo Switch Pro Controller ==========================================
// Battery lives in byte[2] of the standard input report 0x30 (~60 Hz) and in the
// subcommand reply 0x21:
//   level nibble = byte[2] >> 4 : 8=full, 6=medium, 4=low, 2=critical, 0=empty
//   charging     = byte[2] & 0x01  (1 = charging)
// Only 5 coarse levels -> mapped to ~100/75/50/25/5 % for the bar/colour.
//
// Bluetooth note: after pairing the controller starts in "simple HID" mode and
// sends ONLY report 0x3F (buttons, NO battery). It streams 0x30 only after the
// "set input report mode = 0x30" subcommand.
//
// USB note: same VID/PID, but over the cable the controller sends NOTHING until
// it gets the USB bring-up commands (output report 0x80: 0x02 = handshake,
// 0x04 = keep talking HID over USB). After that the same 0x03/0x30 subcommand
// enables the full report with battery.
const VENDOR_ID = 0x057E;
const PRODUCT_ID = 0x2009;

const STD_REPORT_ID = 0x30;     // standard full report (contains battery)
const SUBCMD_REPLY_ID = 0x21;   // subcommand reply (byte[2] like 0x30)
const SIMPLE_REPORT_ID = 0x3F;  // Bluetooth simple mode (NO battery)

// Output report 0x01 = rumble + subcommand. Neutral rumble (no vibration).
const NEUTRAL_RUMBLE = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40];
const OUTPUT_REPORT_LEN = 49;   // proven length for BT output reports (Windows)
const SUBCMD_RESEND_MS = 2000;  // at most this often trigger the mode switch

const USB_OUTPUT_LEN = 64;      // USB output report size
const USB_CMD_HANDSHAKE = 0x02;
const USB_CMD_HID_ONLY = 0x04;  // disables the BT timeout, keeps HID on USB

const NIBBLE_TO_PERCENT = { 8: 100, 6: 75, 4: 50, 2: 25, 0: 5 };
const STALE_MS = 5000;          // no report for this long -> treat as disconnected
const RECONNECT_INTERVAL_MS = 3000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Windows-only heuristic: Bluetooth HID paths go through BTHENUM (and carry the
// HID service class GUID); plain USB paths don't.
const isUsbPath = (path) => !/bthenum|\{00001124-/i.test(path || '');

export function createSwitchProReader() {
  let device = null;
  let lastPercent = -1;
  let lastCharging = false;
  let lastDataAt = 0;
  let openedAt = 0;            // when the current handle was opened
  let outPacket = 0;            // running packet counter for output reports
  let lastSubcmdAt = 0;        // throttle for the mode switch

  function nibbleToPercent(n) {
    if (n in NIBBLE_TO_PERCENT) return NIBBLE_TO_PERCENT[n];
    return Math.max(0, Math.min(100, Math.round((n / 8) * 100)));
  }

  function isStale() {
    return Date.now() - lastDataAt > STALE_MS;
  }

  function sendSubcommand(subcmd, args) {
    if (!device) return;
    const b = Buffer.alloc(OUTPUT_REPORT_LEN);
    b[0] = 0x01;
    b[1] = outPacket++ & 0x0F;
    for (let i = 0; i < 8; i++) b[2 + i] = NEUTRAL_RUMBLE[i];
    b[10] = subcmd;
    for (let i = 0; i < args.length; i++) b[11 + i] = args[i];
    try { device.write([...b]); } catch { /* ignore */ }
  }

  // Switch the controller into the full report (0x30) that contains battery.
  function enableFullReportMode() {
    const now = Date.now();
    if (now - lastSubcmdAt < SUBCMD_RESEND_MS) return;
    lastSubcmdAt = now;
    sendSubcommand(0x03, [STD_REPORT_ID]);
  }

  function sendUsbCommand(cmd) {
    if (!device) return;
    const b = Buffer.alloc(USB_OUTPUT_LEN);
    b[0] = 0x80;
    b[1] = cmd;
    try { device.write([...b]); } catch { /* ignore */ }
  }

  // USB bring-up: without this the controller stays silent over the cable.
  async function usbHandshake() {
    const opened = device;
    for (const cmd of [USB_CMD_HANDSHAKE, USB_CMD_HID_ONLY]) {
      if (device !== opened) return; // handle was replaced mid-handshake
      sendUsbCommand(cmd);
      await sleep(80);
    }
    if (device === opened) enableFullReportMode();
  }

  function handleReport(d) {
    if (d[0] === SIMPLE_REPORT_ID) {
      enableFullReportMode();
      return;
    }
    if (d[0] !== STD_REPORT_ID && d[0] !== SUBCMD_REPLY_ID) return;
    const b = d[2];
    lastPercent = nibbleToPercent((b >> 4) & 0x0F);
    lastCharging = (b & 0x01) === 1;
    lastDataAt = Date.now();
  }

  function closeDevice() {
    if (device) {
      try { device.close(); } catch { /* ignore */ }
    }
    device = null;
  }

  function connect() {
    const candidates = HID.devices().filter(d =>
      d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
    if (candidates.length === 0) return;
    // Prefer the cable when the controller shows up on both transports.
    const info = candidates.find(d => isUsbPath(d.path)) || candidates[0];
    try {
      device = new HID.HID(info.path);
    } catch {
      device = null;
      return;
    }
    const usb = isUsbPath(info.path);
    console.log(`[switchpro] connected (${usb ? 'usb' : 'bluetooth'}):`, info.product || info.path);
    openedAt = Date.now();
    lastSubcmdAt = 0;   // allow an immediate mode switch on a fresh connection
    device.on('data', data => handleReport([...data]));
    device.on('error', () => { closeDevice(); });
    if (usb) usbHandshake();
    else enableFullReportMode(); // don't wait for a button press to see a 0x3F
  }

  return {
    id: 'switchpro',
    name: 'Switch Pro Controller',
    start() {
      connect();
      setInterval(() => {
        // A handle that stopped producing data is dead weight (e.g. the
        // controller hopped transports): drop it and reopen on the live one.
        if (device && Date.now() - Math.max(openedAt, lastDataAt) > STALE_MS) {
          closeDevice();
        }
        if (!device) connect();
      }, RECONNECT_INTERVAL_MS);
    },
    getState() {
      if (!device || lastPercent < 0 || isStale()) return { connected: false };
      return { connected: true, value: lastPercent, charging: lastCharging };
    },
  };
}
