import HID from 'node-hid';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// === Logitech G HUB local database (preferred battery source) ===============
// G HUB itself already talks HID++ to the mouse and stores its own calibrated
// battery reading in a local SQLite settings file, refreshed continuously
// while G HUB is running. That reading is far more trustworthy than voltage
// guessed from a single poll: it doesn't get fooled by the terminal-voltage
// spike that happens while the mouse is actively charging (our own curve-based
// estimate does, since charging current pushes measured voltage well above
// what the discharge curve assumes). When G HUB is running we prefer its
// percentage and fall back to our own HID++ voltage read otherwise.
const GHUB_DB_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'LGHUB', 'settings.db')
  : null;
const GHUB_MAX_AGE_MS = 5 * 60 * 1000; // ignore stale G HUB snapshots, fall back to direct read
const GHUB_BATTERY_KEY = /^battery\/.+\/percentage$/;

function readGhubBattery() {
  if (!GHUB_DB_PATH) return null;
  let db;
  try {
    db = new DatabaseSync(GHUB_DB_PATH, { readOnly: true });
    const row = db.prepare('SELECT file FROM data ORDER BY _id DESC LIMIT 1').get();
    if (!row) return null;
    const settings = JSON.parse(Buffer.from(row.file).toString('utf8'));
    const key = Object.keys(settings).find((k) => GHUB_BATTERY_KEY.test(k));
    const entry = key && settings[key];
    if (!entry || typeof entry.percentage !== 'number') return null;
    const age = Date.now() - new Date(entry.time).getTime();
    if (!(age >= 0) || age > GHUB_MAX_AGE_MS) return null;
    return {
      percentage: entry.percentage,
      charging: typeof entry.isCharging === 'boolean' ? entry.isCharging : undefined,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// === Logitech G502 Lightspeed (receiver or USB cable) ========================
// The mouse speaks HID++ 2.0 either through the Lightspeed receiver (wireless)
// or directly when plugged in via cable — the cable makes it enumerate as its
// own USB device with a different PID, and it only answers on the transport it
// is currently using, so the reader follows it back and forth. Battery comes
// from feature 0x1001 (BATTERY_VOLTAGE): the device reports a battery voltage
// in mV plus a status byte (bit 7 = charging). Voltage is mapped to a % via a
// Li-ion curve. We resolve the HID++ device index (1..n on the receiver, 0xFF
// when wired) and the feature index at runtime, then poll periodically and also
// listen for the device's own spontaneous voltage notifications. Active polling
// coexists with Logitech G HUB (we tag our requests with a software id and
// retry transient BUSY errors).
const LOGITECH = 0x046D;
const RECEIVER_PID = 0xC539;       // Logitech Lightspeed USB receiver
const WIRED_PID = 0xC08D;          // G502 Lightspeed plugged in via USB cable
const WIRED_DEVICE_INDEX = 0xFF;   // HID++ device index for direct-attached devices
const SW_ID = 0x09;                // software-id tag on our HID++ requests
const LONG_REPORT_ID = 0x11;       // HID++ long message
const LONG_LEN = 20;
const BATTERY_VOLTAGE = 0x1001;    // HID++ 2.0 feature id
const ERR_REPORT_ID = 0x8f;        // HID++ 2.0 error reply marker (in byte[2])
const ERR_BUSY = 0x08;

const TICK_MS = 3000;              // connection/transport check cadence
const POLL_MS = 20000;             // battery poll cadence (battery changes slowly)
const RESOLVE_MS = 8000;           // retry cadence while receiver is up but mouse asleep
const REQUEST_TIMEOUT_MS = 700;
const PING_TIMEOUT_MS = 300;
const BUSY_RETRIES = 6;
const RECEIVER_INDICES = [1, 2, 3]; // device indices to probe on the receiver

// Solaar's Li-ion discharge curve: voltage(mV) -> remaining %.
const VOLTAGE_CURVE = [
  [4186, 100], [4067, 90], [3989, 80], [3922, 70], [3859, 60], [3811, 50],
  [3778, 40], [3751, 30], [3717, 20], [3651, 10], [3567, 5], [3525, 2], [3490, 0],
];
// Linear interpolation between curve points instead of snapping down to the
// nearest one, so the fallback estimate isn't stuck on multiples of 10.
function voltageToPercent(mv) {
  if (mv >= VOLTAGE_CURVE[0][0]) return 100;
  for (let i = 0; i < VOLTAGE_CURVE.length - 1; i++) {
    const [vHi, pHi] = VOLTAGE_CURVE[i];
    const [vLo, pLo] = VOLTAGE_CURVE[i + 1];
    if (mv >= vLo) return Math.round(pLo + ((mv - vLo) / (vHi - vLo)) * (pHi - pLo));
  }
  return 0;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createG502Reader() {
  let device = null;
  let mode = null;       // 'receiver' | 'wired'
  let deviceIndex = 0;   // HID++ device index (1..n on receiver, 0xFF wired; 0 = unresolved)
  let featureIndex = 0;  // resolved index of feature 0x1001 (0 = unresolved)
  let lastPercent = -1;
  let lastCharging = false;
  let lastPollAt = 0;
  let lastResolveAt = 0;

  function receiverInfo() {
    return HID.devices().find(d =>
      d.vendorId === LOGITECH && d.productId === RECEIVER_PID &&
      d.usagePage === 0xFF00 && d.usage === 2);
  }

  // The vendor HID++ interface of the mouse itself when plugged in via cable.
  // Matched by PID or product name in case the firmware reports a different
  // PID; modern devices put long HID++ reports on usage page 0xFF43, older
  // firmwares use 0xFF00 usage 2 like the receiver does.
  function wiredInfo() {
    return HID.devices().find(d =>
      d.vendorId === LOGITECH &&
      (d.productId === WIRED_PID || /G502/i.test(d.product || '')) &&
      (d.usagePage === 0xFF43 || (d.usagePage === 0xFF00 && d.usage === 2)));
  }

  function closeDevice() {
    if (device) {
      try { device.close(); } catch { /* ignore */ }
    }
    device = null;
    mode = null;
    deviceIndex = 0;
    featureIndex = 0;
    lastPercent = -1;
    lastCharging = false;
    lastPollAt = 0;
    lastResolveAt = 0;
  }

  // Send one HID++ long request and resolve with the first matching reply.
  function once(devIdx, featIdx, funcId, params = [], timeout = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (!device) return resolve({ raw: null });
      const buf = Buffer.alloc(LONG_LEN);
      buf[0] = LONG_REPORT_ID;
      buf[1] = devIdx;
      buf[2] = featIdx;
      buf[3] = ((funcId & 0x0F) << 4) | SW_ID;
      for (let i = 0; i < params.length; i++) buf[4 + i] = params[i];

      let done = false;
      const finish = (d, err) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (device) device.removeListener('data', onData);
        resolve({ raw: d, error: !!err });
      };
      const onData = (data) => {
        const d = [...data];
        if (d[1] !== devIdx) return;
        if (d[2] === ERR_REPORT_ID && (d[4] & 0x0F) === SW_ID) return finish(d, true);
        if (d[2] === featIdx && (d[3] & 0x0F) === SW_ID) return finish(d);
      };
      const t = setTimeout(() => finish(null), timeout);
      device.on('data', onData);
      try { device.write([...buf]); } catch { finish(null); }
    });
  }

  // Like once(), but retries through transient BUSY (0x08) errors.
  async function req(devIdx, featIdx, funcId, params = []) {
    for (let i = 0; i < BUSY_RETRIES; i++) {
      const r = await once(devIdx, featIdx, funcId, params);
      if (r.raw && r.error && r.raw[5] === ERR_BUSY) { await sleep(120); continue; }
      if (r.raw) return r;
      await sleep(120);
    }
    return { raw: null };
  }

  // Find which device index is the mouse and the index of feature 0x1001.
  async function resolveDevice() {
    const indices = mode === 'wired' ? [WIRED_DEVICE_INDEX] : RECEIVER_INDICES;
    for (const idx of indices) {
      const ping = await once(idx, 0x00, 0x01, [0, 0, 0xAB], PING_TIMEOUT_MS); // IRoot.getProtocolVersion
      if (!ping.raw) continue;
      const feat = await req(idx, 0x00, 0x00, [(BATTERY_VOLTAGE >> 8) & 0xFF, BATTERY_VOLTAGE & 0xFF]);
      if (feat.raw && !feat.error && feat.raw[4] !== 0) {
        deviceIndex = idx;
        featureIndex = feat.raw[4];
        console.log(`[g502] resolved ${mode} device index ${idx}, battery feature index ${featureIndex}`);
        return true;
      }
    }
    return false;
  }

  function decodeVoltage(d) {
    const mv = (d[4] << 8) | d[5];
    if (mv < 2000 || mv > 5000) return; // sanity
    lastPercent = voltageToPercent(mv);
    lastCharging = (d[6] & 0x80) !== 0;
  }

  async function poll() {
    const r = await req(deviceIndex, featureIndex, 0x00); // getBatteryVoltage
    if (r.raw && !r.error) decodeVoltage(r.raw);
    // no reply: mouse asleep -> keep the last known value (battery is unchanged)

    // G HUB's own calibrated reading overrides our voltage-based estimate
    // whenever it's available and fresh.
    const ghub = readGhubBattery();
    if (ghub) {
      lastPercent = ghub.percentage;
      if (typeof ghub.charging === 'boolean') lastCharging = ghub.charging;
    }
  }

  // Open whichever transport the mouse is currently on; the cable wins because
  // the mouse stops answering through the receiver while it is plugged in.
  function openDevice() {
    const wired = wiredInfo();
    const info = wired || receiverInfo();
    if (!info) return false;
    try {
      device = new HID.HID(info.path);
    } catch {
      device = null;
      return false;
    }
    mode = wired ? 'wired' : 'receiver';
    console.log(`[g502] ${mode} interface opened`);
    // Always-on listener for the device's spontaneous voltage notifications.
    device.on('data', (data) => {
      const d = [...data];
      if (deviceIndex && featureIndex &&
          d[0] === LONG_REPORT_ID && d[1] === deviceIndex && d[2] === featureIndex) {
        decodeVoltage(d);
      }
    });
    device.on('error', () => { closeDevice(); });
    return true;
  }

  async function tick() {
    // Follow the mouse when it hops transports (cable plugged in / pulled out).
    const wiredPresent = !!wiredInfo();
    if (device && mode === 'receiver' && wiredPresent) closeDevice();
    if (device && mode === 'wired' && !wiredPresent) closeDevice();

    if (!device && !openDevice()) return;
    const now = Date.now();
    if (!deviceIndex || !featureIndex) {
      if (now - lastResolveAt < RESOLVE_MS && lastResolveAt) return;
      lastResolveAt = now;
      if (!(await resolveDevice())) return;
    } else if (now - lastPollAt < POLL_MS) {
      return;
    }
    await poll();
    lastPollAt = Date.now();
  }

  // Self-scheduling loop so requests never overlap. Ticks are frequent so a
  // transport switch is picked up quickly; resolve/poll throttle themselves.
  async function loop() {
    try { await tick(); } catch { /* ignore */ }
    setTimeout(loop, TICK_MS);
  }

  return {
    id: 'g502',
    name: 'G502 Lightspeed',
    start() { loop(); },
    getState() {
      if (!device || lastPercent < 0) return { connected: false };
      return { connected: true, value: lastPercent, charging: lastCharging };
    },
  };
}
