# HTTP API

The HTTP API presents one control model over both supported communication methods: authenticated Focusrite Control 2 and direct USB/FCP. The server listens on `http://127.0.0.1:41780` by default. Responses contain `"ok": true` on success or `"ok": false` and an `error` message on failure.

`focusrite network enable` changes the listener to `0.0.0.0:41780` and creates a random access token. Every non-loopback request must then include:

```http
Authorization: Bearer GENERATED_TOKEN
```

Loopback requests remain credential-free. Tokens are stored only in the user's mode-`0600` configuration file and are omitted from configuration API responses and support bundles.

The dashboard's remote launch URL passes the token once, stores it for that browser tab only, and removes it from the visible address bar. Prefer the normal `Authorization` header for integrations.

The selected method is persistent and shared by the CLI and dashboard. Ordinary control endpoints work with either method; `/api/v1/usb/*` endpoints expose capabilities that require direct USB.

## Status and controls

- `GET /api/v1/health` — service, backend, pairing, and connection state
- `GET /api/v1/device` — dynamic device identity and transport details
- `GET /api/v1/controls` — control types, labels, aliases, ranges, and enum values
- `GET /api/v1/state` — every ordinary control and its current value
- `POST /api/v1/reconnect` — close and recreate the persistent communication session
- `POST /api/v1/backend` — close the active transport, persist `fc2` or `usb`, and connect through the selected method

Control definitions may include `disabledWhen: { "control": "monitor-1-hardware-control", "value": true }` and a `disabledReason`. Check the referenced value before enabling that control in a client. The server also enforces this condition before writing a batch.

Optional USB Auto Gain configuration and front-panel metering fields may be advertised as writable in the device map even when their notifications are rejected. Their configuration events are checked once per connection using current values, without data writes. A rejected event produces `access: "read-only"`, an explanatory `disabledReason`, and `notificationSupport: { "supported": false, "event": 36, "errorCode": 7 }` (the event and error vary by control/device). Ambiguous event metadata instead includes a `reason`. Unsupported setters are rejected before any writes, including earlier entries in the same batch. Reads remain available. Reconnect clears the cached result so newer firmware can expose supported settings without a firmware-specific code change.

A device-rejected optional field is reported by `/api/v1/state` with `partial: true` and an `unavailable` object mapping control names to errors. Do not interpret a missing value as `false` or zero. USB transport failures instead return HTTP 503; the failed session is discarded so a later request can reconnect. Failed USB mutations are not silently replayed. The CLI treats partial full-state reads as errors, and the dashboard disables unavailable controls and displays the error.

FC2 gain limits are read from the live AES70 response. Monitor gain uses whole-dB steps on the tested device; input preamp gain retains half-dB steps. Setters normalize values to the declared step and verify the resulting value rather than reporting an acknowledged but ineffective write as successful.

Select a communication method:

```http
POST /api/v1/backend
Content-Type: application/json

{ "backend": "fc2" }
```

The response reports the selected method, connection state, detected device, advertised FC2 ports when applicable, and a human-readable connection error when the selection was saved but could not connect immediately.

Direct USB builds its control list from the device map. Do not assume that every model returns the same names. FC2 control availability is determined by the objects published by the paired FC2 service.

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

The API is localhost-only unless authenticated network access is explicitly enabled. It rejects unauthenticated remote requests, cross-origin browser requests, and cross-site mutations.
