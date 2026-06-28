import express from 'express';
import { WebSocketServer } from 'ws';

import { createHyperXReader } from './readers/hyperx.js';
import { createSwitchProReader } from './readers/switchpro.js';
import { createG502Reader } from './readers/g502.js';

// One background service that reads every supported device and broadcasts all of
// their battery states over a single WebSocket. The Stream Deck plugin connects
// here and each key picks which device to display.
const PORT_WS = 3100;
const PORT_HTTP = 3101;
const BROADCAST_INTERVAL_MS = 1000;

const readers = [
  createHyperXReader(),
  createSwitchProReader(),
  createG502Reader(),
];

for (const reader of readers) reader.start();

// Combined snapshot of all devices, keyed by device id.
function snapshot() {
  const devices = {};
  for (const reader of readers) {
    devices[reader.id] = { id: reader.id, name: reader.name, ...reader.getState() };
  }
  return { type: 'devices', devices };
}

const wss = new WebSocketServer({ port: PORT_WS });

wss.on('connection', (ws) => {
  console.log('Stream Deck plugin connected');
  // Send the current snapshot immediately so a new key doesn't wait a second.
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(snapshot()));
});

setInterval(() => {
  const json = JSON.stringify(snapshot());
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(json);
  }
}, BROADCAST_INTERVAL_MS);

const app = express();
app.get('/', (req, res) => res.json(snapshot()));
app.listen(PORT_HTTP, () => console.log(`HTTP server on port ${PORT_HTTP}`));

console.log(`WebSocket server on port ${PORT_WS}`);
