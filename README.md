# Device Battery — Stream Deck plugin

A single Elgato Stream Deck plugin that shows the battery level of:

- **HyperX Cloud 3 Wireless** (headset)
- **Nintendo Switch Pro Controller** (USB and Bluetooth)
- **Logitech G502 Lightspeed** (mouse, via the Lightspeed receiver)

Each key picks which device it displays, so you can show all three at once. The
icon turns **green → amber → red** as the battery drops, shows a **lightning bolt**
while charging, and a **"?"** when the device is off/asleep or the service isn't
running.

## How it works

Two pieces:

1. **`service/`** — a small Node.js background service. It reads all three devices
   directly over USB/HID and broadcasts their battery states over a single
   WebSocket (`ws://localhost:3100`). It auto-reconnects to each device and keeps
   running in the background.
2. **`plugin/`** — the Stream Deck plugin (TypeScript). It connects to the service,
   caches every device's state, and renders the battery icon for the device chosen
   on each key. It reconnects automatically, so service and plugin can start in any
   order.

```
HID devices ──> service (Node, node-hid) ──ws://localhost:3100──> plugin (Stream Deck)
```

### Why a separate service?

Stream Deck plugins run on an embedded Node.js. Building the native `node-hid`
module against that runtime is fragile, so HID access lives in a standalone service
and the plugin just consumes a WebSocket. The plugin reconnects with backoff, so a
service restart is recovered without restarting Stream Deck.

## Device notes

| Device | How battery is read |
| --- | --- |
| HyperX Cloud 3 | HID VID `0x03F0` / PID `0x05B7`, usage page `65299`. Report header `102`; type `13` byte[4] = level %, type `12` byte[2] = charging, type `11` = powered off. |
| Switch Pro Controller | HID VID `0x057E` / PID `0x2009`. Battery in byte[2] of report `0x30`/`0x21`: `>>4` = level (8/6/4/2/0 → ~100/75/50/25/5 %), `&1` = charging. Over Bluetooth it boots in "simple" mode (report `0x3F`, no battery); the service sends the `0x03 0x30` subcommand to switch it into the full report. |
| G502 Lightspeed | Logitech Lightspeed receiver (VID `0x046D` / PID `0xC539`), HID++ 2.0 feature `0x1001` (battery voltage). Voltage (mV) is mapped to a % via a Li-ion discharge curve. Coexists with Logitech G HUB. |

The G502 voltage→percent curve is taken from the
[Solaar](https://github.com/pwr-Solaar/Solaar) project.

## Setup

### Service

```sh
cd service
npm install          # builds/fetches node-hid for your platform
npm start            # or: node service.js
```

Autostart at logon (Windows, no admin needed):

```powershell
powershell -ExecutionPolicy Bypass -File service\install-autostart.ps1
# remove with:  ... install-autostart.ps1 -Remove
```

This drops a hidden shortcut in your Startup folder that launches `start.vbs`
(runs the service with no console window).

### Plugin

```sh
cd plugin
npm install
npm run build                                   # builds com.pixel.devicebattery.sdPlugin/bin/plugin.js
npx streamdeck link com.pixel.devicebattery.sdPlugin
```

If the plugin was just linked for the first time, fully restart the Stream Deck app
(a `streamdeck restart` is a no-op for a never-loaded plugin).

## Configuration (per key)

- **Device** — HyperX Cloud 3 / Switch Pro Controller / G502 Lightspeed
- **Show percentage** — draw the % inside the icon
- **Warning threshold (%)** — icon turns red at/below this level

## Ports

- WebSocket: `3100`
- HTTP (health/JSON snapshot at `/`): `3101`

## License

MIT
