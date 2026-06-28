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
// "set input report mode = 0x30" subcommand. Over USB it streams 0x30 right away.
const VENDOR_ID = 0x057E;
const PRODUCT_ID = 0x2009;

const STD_REPORT_ID = 0x30;     // standard full report (contains battery)
const SUBCMD_REPLY_ID = 0x21;   // subcommand reply (byte[2] like 0x30)
const SIMPLE_REPORT_ID = 0x3F;  // Bluetooth simple mode (NO battery)

// Output report 0x01 = rumble + subcommand. Neutral rumble (no vibration).
const NEUTRAL_RUMBLE = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40];
const OUTPUT_REPORT_LEN = 49;   // proven length for BT output reports (Windows)
const SUBCMD_RESEND_MS = 2000;  // at most this often trigger the mode switch

const NIBBLE_TO_PERCENT = { 8: 100, 6: 75, 4: 50, 2: 25, 0: 5 };
const STALE_MS = 5000;          // no report for this long -> treat as disconnected
const RECONNECT_INTERVAL_MS = 3000;

export function createSwitchProReader() {
  let device = null;
  let lastPercent = -1;
  let lastCharging = false;
  let lastDataAt = 0;
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
  // Only needed over Bluetooth (simple mode); never triggered over USB.
  function enableFullReportMode() {
    const now = Date.now();
    if (now - lastSubcmdAt < SUBCMD_RESEND_MS) return;
    lastSubcmdAt = now;
    sendSubcommand(0x03, [0x30]);
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
    const info = HID.devices().find(d =>
      d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
    if (!info) return;
    try {
      device = new HID.HID(info.path);
    } catch {
      device = null;
      return;
    }
    console.log('[switchpro] connected:', info.product || info.path);
    lastSubcmdAt = 0;   // allow an immediate mode switch on a fresh connection
    device.on('data', data => handleReport([...data]));
    device.on('error', () => { closeDevice(); });
  }

  return {
    id: 'switchpro',
    name: 'Switch Pro Controller',
    start() {
      connect();
      setInterval(() => { if (!device) connect(); }, RECONNECT_INTERVAL_MS);
    },
    getState() {
      if (!device || lastPercent < 0 || isStale()) return { connected: false };
      return { connected: true, value: lastPercent, charging: lastCharging };
    },
  };
}
