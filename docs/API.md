# HTTP API

The server listens on `http://127.0.0.1:41780` by default. Successful responses contain `"ok": true`; errors contain `"ok": false` and an `error` message.

## Discovery and status

### `GET /api/v1/health`

Reports service health, pairing state, Focusrite Control 2 availability, and secure-session status.

### `GET /api/v1/device`

Reads the product name, serial number, and firmware version from the connected interface. It also reports the AES70 transport endpoint and public identities used by the connection.

### `GET /api/v1/controls`

Lists stable control names, aliases, types, ranges, and display labels.

### `GET /api/v1/state`

Reads all supported controls in one batched AES70 request.

## Individual controls

### `GET /api/v1/control/:name/get`

Reads one control.

### `POST /api/v1/control/:name/set`

```json
{ "value": -24 }
```

Boolean values accept `true`, `false`, `on`, `off`, `1`, and `0`.

### `GET /api/v1/control/:name/:value`

A convenience route for clients that cannot issue POST requests:

```text
GET /api/v1/control/dim/on
GET /api/v1/control/monitor-gain/-24
```

### `GET /api/v1/control/:name/toggle`

Toggles a boolean control. Although state-changing GET requests are normally discouraged, this local-only route exists for automation tools that cannot issue POST requests. General integrations should use the batch POST endpoint.

## Batch operations

### `POST /api/v1/batch`

```json
{
  "operations": [
    { "control": "dim", "value": true },
    { "control": "monitor-gain", "value": -30 },
    { "control": "input1-air", "action": "toggle" }
  ]
}
```

The server accepts 1–100 operations. Writes are scheduled together on the persistent connection and affected controls are verified in one follow-up read.

## Configuration and pairing

- `GET /api/v1/config`
- `POST /api/v1/config`
- `GET /api/v1/pair`
- `POST /api/v1/pair/start`
- `POST /api/v1/pair/qr`

The QR endpoint accepts `{ "dataUrl": "data:image/png;base64,..." }` after approval.

## Supported controls

| Name | Type | Range |
|---|---|---|
| `dim` | Boolean | on/off |
| `monitor-mute` | Boolean | on/off |
| `monitor-gain` | Number | -80 to +6 dB |
| `input1-gain` | Number | 0 to 69 dB |
| `input1-air` | Boolean | on/off |
| `input1-phantom` | Boolean | on/off |
| `input1-instrument` | Boolean | on/off |
| `input2-gain` | Number | 0 to 69 dB |
| `input2-air` | Boolean | on/off |
| `input2-phantom` | Boolean | on/off |
| `input2-instrument` | Boolean | on/off |

These mappings are specific to the tested Scarlett 16i16 4th Gen firmware. Validate object mappings before adding another model.
