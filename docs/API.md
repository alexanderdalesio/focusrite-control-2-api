# HTTP API

The server listens on `http://127.0.0.1:41780` by default. Responses contain `"ok": true` on success or `"ok": false` and an `error` message on failure.

## Status and controls

- `GET /api/v1/health` — service, backend, pairing, and connection state
- `GET /api/v1/device` — dynamic device identity and transport details
- `GET /api/v1/controls` — control types, labels, aliases, ranges, and enum values
- `GET /api/v1/state` — every ordinary control and its current value
- `POST /api/v1/reconnect` — close and recreate the persistent backend session
- `POST /api/v1/backend` — close the current transport, persist `fc2` or `usb`, and connect through the selected backend

Switch backend:

```http
POST /api/v1/backend
Content-Type: application/json

{ "backend": "fc2" }
```

The response reports the selected backend, connection state, detected device, advertised FC2 ports when applicable, and a human-readable connection error when the selection was saved but could not connect immediately.

The direct backend builds its control list from the device map. Do not assume that every model returns the same names.

## Individual controls

Read a control:

```text
GET /api/v1/control/:name/get
```

Set a control:

```text
POST /api/v1/control/:name/set
Content-Type: application/json

{ "value": -24 }
```

Toggle a boolean:

```text
GET /api/v1/control/:name/toggle
```

For limited automation clients, `GET /api/v1/control/:name/:value` is also supported. General integrations should use POST because state-changing GET requests can be triggered accidentally.

## Batch operations

`POST /api/v1/batch` accepts 1–100 operations:

```json
{
  "operations": [
    { "control": "dim", "value": true },
    { "control": "monitor-gain", "value": -30 },
    { "control": "input1-air", "value": "presence-drive" },
    { "control": "input1-mute", "action": "toggle" }
  ]
}
```

Operations are serialized through the existing connection. Direct USB writes and affected values are verified before the response is returned.

## Direct USB routing

### `GET /api/v1/usb/routing`

Returns the named sources, destinations, route selected at each destination, writability, and the three sample-rate routing-table views.

### `POST /api/v1/usb/routing`

```json
{ "destination": "Monitor 3", "source": "USB 3" }
```

Every routing table containing that destination is updated and read back. Device-declared fixed routes are rejected.

## Direct USB mixer

- `GET /api/v1/usb/mixer/info` — dimensions and named input/output channels
- `GET /api/v1/usb/mixer?output=Mixer%201` — one mixer output and its 36 input levels
- `POST /api/v1/usb/mixer` — update one crosspoint

```json
{
  "output": "Mixer 1",
  "input": "Analogue 1",
  "value": -6
}
```

`value` accepts `-80` through `12` dB or the string `"mute"`. The full mixer row is preserved while the selected coefficient is changed.

## Direct USB meters and device-map diagnostics

- `GET /api/v1/usb/meters` — raw and dBFS values for named meter channels
- `GET /api/v1/usb/led` — report visible LED-control support and internal map evidence
- `POST /api/v1/usb/led` — compatibility endpoint; returns `501` when visible LED control is unsupported
- `GET /api/v1/usb/device-map?search=air` — inspect safe device-map metadata

```json
{
  "supported": false,
  "reason": "Visible per-index LED and gain-halo colour control is not supported...",
  "internalCommandBuffer": { "present": true, "capacity": 48 }
}
```

The internal capacity is not a count of user-addressable physical LEDs. The response also includes read-only ESP32 front-panel firmware, IPC, encryption, reset, and state diagnostics.

## Configuration and pairing

- `GET /api/v1/config`
- `POST /api/v1/config`
- `GET /api/v1/pair`
- `POST /api/v1/pair/start`
- `POST /api/v1/pair/qr`

Pairing applies only to the FC2 backend. The QR endpoint accepts `{ "dataUrl": "data:image/png;base64,..." }` after the approval step.

The API is local-only. It rejects non-local host headers, cross-origin browser requests, and cross-site mutations.
