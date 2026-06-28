import HID from 'node-hid';

// === Logitech G502 Lightspeed (via the Lightspeed USB receiver) ==============
// The mouse speaks HID++ 2.0 through the receiver. Battery comes from feature
// 0x1001 (BATTERY_VOLTAGE): the device reports a battery voltage in mV plus a
// status byte (bit 7 = charging). Voltage is mapped to a % via a Li-ion curve.
// We resolve the HID++ device index (1..n on the receiver) and the feature
// index at runtime, then poll periodically and also listen for the device's own
// spontaneous voltage notifications. Active polling coexists with Logitech G HUB
// (we tag our requests with a software id and retry transient BUSY errors).
const LOGITECH = 0x046D;
const RECEIVER_PID = 0xC539;       // Logitech Lightspeed USB receiver
const SW_ID = 0x09;                // software-id tag on our HID++ requests
const LONG_REPORT_ID = 0x11;       // HID++ long message
const LONG_LEN = 20;
const BATTERY_VOLTAGE = 0x1001;    // HID++ 2.0 feature id
const ERR_REPORT_ID = 0x8f;        // HID++ 2.0 error reply marker (in byte[2])
const ERR_BUSY = 0x08;

const POLL_MS = 20000;             // battery poll cadence (battery changes slowly)
const RESOLVE_MS = 8000;           // retry cadence while receiver is up but mouse asleep
const RECONNECT_MS = 4000;         // retry cadence while the receiver is missing
const REQUEST_TIMEOUT_MS = 700;
const PING_TIMEOUT_MS = 300;
const BUSY_RETRIES = 6;
const MAX_DEVICE_INDEX = 3;        // probe device indices 1..3 on the receiver

// Solaar's Li-ion discharge curve: voltage(mV) -> remaining %.
const VOLTAGE_CURVE = [
  [4186, 100], [4067, 90], [3989, 80], [3922, 70], [3859, 60], [3811, 50],
  [3778, 40], [3751, 30], [3717, 20], [3651, 10], [3567, 5], [3525, 2], [3490, 0],
];
function voltageToPercent(mv) {
  for (const [v, p] of VOLTAGE_CURVE) if (mv >= v) return p;
  return 0;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createG502Reader() {
  let device = null;
  let deviceIndex = 0;   // HID++ device index on the receiver (0 = unresolved)
  let featureIndex = 0;  // resolved index of feature 0x1001 (0 = unresolved)
  let lastPercent = -1;
  let lastCharging = false;

  function receiverInfo() {
    return HID.devices().find(d =>
      d.vendorId === LOGITECH && d.productId === RECEIVER_PID &&
      d.usagePage === 0xFF00 && d.usage === 2);
  }

  function closeDevice() {
    if (device) {
      try { device.close(); } catch { /* ignore */ }
    }
    device = null;
    deviceIndex = 0;
    featureIndex = 0;
    lastPercent = -1;
    lastCharging = false;
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
    for (let idx = 1; idx <= MAX_DEVICE_INDEX; idx++) {
      const ping = await once(idx, 0x00, 0x01, [0, 0, 0xAB], PING_TIMEOUT_MS); // IRoot.getProtocolVersion
      if (!ping.raw) continue;
      const feat = await req(idx, 0x00, 0x00, [(BATTERY_VOLTAGE >> 8) & 0xFF, BATTERY_VOLTAGE & 0xFF]);
      if (feat.raw && !feat.error && feat.raw[4] !== 0) {
        deviceIndex = idx;
        featureIndex = feat.raw[4];
        console.log(`[g502] resolved device index ${idx}, battery feature index ${featureIndex}`);
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
  }

  function openReceiver() {
    const info = receiverInfo();
    if (!info) return false;
    try {
      device = new HID.HID(info.path);
    } catch {
      device = null;
      return false;
    }
    console.log('[g502] receiver opened');
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
    if (!device) {
      openReceiver();
      return;
    }
    if (!deviceIndex || !featureIndex) {
      if (await resolveDevice()) await poll();
      return;
    }
    await poll();
  }

  // Self-scheduling loop so requests never overlap; cadence depends on state.
  async function loop() {
    try { await tick(); } catch { /* ignore */ }
    const delay = (device && deviceIndex && featureIndex) ? POLL_MS
      : device ? RESOLVE_MS
        : RECONNECT_MS;
    setTimeout(loop, delay);
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
