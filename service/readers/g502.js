import HID from 'node-hid';
import WebSocket from 'ws';

// === Logitech G HUB agent API (preferred battery source) =====================
// G HUB's background agent exposes the same local WebSocket API its own UI
// uses (ws://127.0.0.1:9010, subprotocol "json"). GET /battery/<id>/state
// returns the calibrated state-of-charge the G HUB window displays — the mouse
// supports real SoC reporting (batteryStateOfChargeSupport), so this reading
// stays correct while charging, unlike a voltage estimate: charging current
// pushes the measured terminal voltage far above what a discharge curve
// assumes (observed: 4155 mV while charging → curve says 97%, true SoC 58%).
// We keep a persistent connection, poll the state, and subscribe to pushed
// battery events. When G HUB isn't running we fall back to our own HID++
// voltage read. (The previous approach — reading G HUB's settings.db — was
// unreliable: the battery key only intermittently exists in that file.)
const GHUB_WS_URL = 'ws://127.0.0.1:9010';
const GHUB_POLL_MS = 10000;        // refresh cadence for /battery/<id>/state
const GHUB_RECONNECT_MS = 15000;   // retry cadence while G HUB is not running
const GHUB_MAX_AGE_MS = 60000;     // reading older than this -> fall back to voltage

function createGhubClient(onUpdate) {
  let ws = null;
  let deviceId = null;
  let pollTimer = null;
  let lastUpdateAt = 0;
  let announced = false;
  let stopped = false;

  function send(path, verb = 'GET') {
    try { ws.send(JSON.stringify({ msgId: '', verb, path })); } catch { /* ignore */ }
  }

  function cleanup() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (ws) { try { ws.terminate(); } catch { /* ignore */ } }
    ws = null;
    deviceId = null;
    announced = false;
  }

  // Runs on a fixed cadence once connected. Requests are fire-and-forget, so a
  // lost or ignored reply (the agent occasionally drops the first request
  // right after its OPTIONS handshake) must not stall the client: while the
  // device is unresolved we keep re-asking for the device list, and if battery
  // updates stop arriving we re-resolve in case G HUB re-enumerated the device
  // under a new id.
  function pollTick() {
    if (!deviceId || Date.now() - lastUpdateAt > 3 * GHUB_POLL_MS) {
      send('/devices/list');
    }
    if (deviceId) send(`/battery/${deviceId}/state`);
  }

  function connect() {
    if (stopped) return;
    const sock = new WebSocket(GHUB_WS_URL, 'json', { handshakeTimeout: 3000 });
    ws = sock;

    sock.on('open', () => {
      console.log('[g502] G HUB agent connected');
      send('/devices/list');
      pollTimer = setInterval(pollTick, GHUB_POLL_MS);
    });

    sock.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const payload = msg?.payload;

      if (msg?.path === '/devices/list' && Array.isArray(payload?.deviceInfos)) {
        const dev = payload.deviceInfos.find((d) => /g502/i.test(d.deviceModel || ''))
          ?? payload.deviceInfos.find((d) => d.deviceType === 'MOUSE');
        if (!dev) return;
        deviceId = dev.id;
        if (!announced) {
          announced = true;
          console.log(`[g502] G HUB battery source active (${dev.displayName || deviceId})`);
        }
        send(`/battery/${deviceId}/state`);
        send('/battery/state/changed', 'SUBSCRIBE');
        return;
      }

      // Battery state — either our GET reply or a pushed /battery/state/changed
      // event; both carry the same payload shape.
      if (deviceId && payload?.deviceId === deviceId && typeof payload.percentage === 'number') {
        lastUpdateAt = Date.now();
        onUpdate({
          percent: payload.fullyCharged ? 100 : payload.percentage,
          charging: !!payload.charging,
          at: lastUpdateAt,
        });
      }
    });

    const retry = () => {
      if (ws !== sock) return; // stale socket
      cleanup();
      if (!stopped) setTimeout(connect, GHUB_RECONNECT_MS);
    };
    sock.on('close', retry);
    sock.on('error', retry);
  }

  return {
    start() { connect(); },
    stop() { stopped = true; cleanup(); },
  };
}

// === Logitech G502 Lightspeed (receiver or USB cable) ========================
// The mouse speaks HID++ 2.0 either through the Lightspeed receiver (wireless)
// or directly when plugged in via cable — the cable makes it enumerate as its
// own USB device with a different PID, and it only answers on the transport it
// is currently using, so the reader follows it back and forth. Battery comes
// from feature 0x1001 (BATTERY_VOLTAGE): the device reports a battery voltage
// in mV plus a status byte (bit 7 = external power). Voltage is mapped to a %
// via a Li-ion curve. We resolve the HID++ device index (1..n on the receiver,
// 0xFF when wired) and the feature index at runtime, then poll periodically and
// also listen for the device's own spontaneous voltage notifications. Active
// polling coexists with Logitech G HUB (we tag our requests with a software id
// and retry transient BUSY errors).
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

// Solaar's Li-ion discharge curve: voltage(mV) -> remaining %. Only valid while
// the battery is actually discharging.
const DISCHARGE_CURVE = [
  [4186, 100], [4067, 90], [3989, 80], [3922, 70], [3859, 60], [3811, 50],
  [3778, 40], [3751, 30], [3717, 20], [3651, 10], [3567, 5], [3525, 2], [3490, 0],
];
// Rough curve for while the mouse is charging: the charge current lifts the
// terminal voltage by up to ~300 mV, so the discharge curve wildly
// overestimates. Anchored on one calibration point from G HUB (4155 mV = 58 %);
// above ~4.19 V the charger is in its constant-voltage phase where voltage
// carries no SoC information at all, so the estimate saturates at 80 % until
// the device reports "full". Only used when G HUB isn't running.
const CHARGE_CURVE = [
  [4190, 80], [4155, 58], [4100, 50], [4000, 36], [3900, 24],
  [3800, 14], [3700, 7], [3600, 2], [3500, 0],
];

// Linear interpolation between curve points instead of snapping down to the
// nearest one, so the fallback estimate isn't stuck on the anchor values.
function voltageToPercent(mv, curve) {
  if (mv >= curve[0][0]) return curve[0][1];
  for (let i = 0; i < curve.length - 1; i++) {
    const [vHi, pHi] = curve[i];
    const [vLo, pLo] = curve[i + 1];
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
  let lastPollAt = 0;
  let lastResolveAt = 0;

  // The two battery sources are kept strictly separate so a voltage frame can
  // never overwrite a fresh G HUB reading. That matters doubly because our HID
  // handle also receives the replies to G HUB's *own* HID++ polling — the
  // spontaneous-notification listener fires constantly while G HUB runs.
  let volt = null;       // { percent, charging, at } — our HID++ voltage estimate
  let ghub = null;       // { percent, charging, at } — G HUB's calibrated reading

  const ghubClient = createGhubClient((reading) => { ghub = reading; });

  function freshGhub() {
    return ghub && Date.now() - ghub.at <= GHUB_MAX_AGE_MS ? ghub : null;
  }

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
    volt = null; // voltage regime changes on plug/unplug; ghub stays valid
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

  // Feature 0x1001 payload: voltage mV (2 bytes) then a flags byte —
  // bit 7 = external power, low bits = charge status (1 = charge complete).
  function decodeVoltage(d) {
    const mv = (d[4] << 8) | d[5];
    if (mv < 2000 || mv > 5000) return; // sanity
    const external = (d[6] & 0x80) !== 0;
    const full = external && (d[6] & 0x07) === 1;
    const percent = full ? 100 : voltageToPercent(mv, external ? CHARGE_CURVE : DISCHARGE_CURVE);
    volt = { percent, charging: external && !full, at: Date.now() };
  }

  async function poll() {
    const r = await req(deviceIndex, featureIndex, 0x00); // getBatteryVoltage
    if (r.raw && !r.error) decodeVoltage(r.raw);
    // no reply: mouse asleep -> keep the last known value (battery is unchanged)
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
    // Always-on listener for the device's spontaneous voltage notifications
    // (this also sees replies to G HUB's own polling — harmless, since it only
    // ever updates the voltage-based fallback source).
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
    start() { loop(); ghubClient.start(); },
    getState() {
      // G HUB's calibrated reading wins whenever it's fresh; our voltage
      // estimate only fills in while G HUB isn't running.
      const src = freshGhub() || volt;
      if (!device || !src) return { connected: false };
      return { connected: true, value: src.percent, charging: src.charging };
    },
  };
}
