# 🎛️ Focusrite Control 2 API

[![CI](https://github.com/alexanderdalesio/focusrite-control-2-api/actions/workflows/ci.yml/badge.svg)](https://github.com/alexanderdalesio/focusrite-control-2-api/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853d)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An unofficial local controller for Focusrite Control 2. Interact with supported controls through a command-line interface, JSON HTTP API, preset files, or the browser dashboard.

> [!IMPORTANT]
> Tested only with **Focusrite Control 2 v1.1081.0.0** and a **Scarlett 16i16 4th Gen running firmware v3.0.2778.0**. Focusrite does not publish this protocol as a supported API, so other software, firmware, and devices may use different AES70 object mappings or authentication behavior.

This independent project is **not affiliated with or endorsed by Focusrite Audio Engineering Limited**. Focusrite and Scarlett are trademarks of their respective owner.

## What it provides

- Persistent authenticated connection with automatic reconnection
- Batched AES70/OCP.1 reads and writes
- Human-readable and JSON command-line output
- Local JSON HTTP API for scripts and integrations
- Browser dashboard with pairing and connection diagnostics
- Presets, health checks, logs, and redacted support bundles
- Optional macOS login service

## Platform support

Focusrite Control 2 is available for Windows and macOS. This client currently supports **macOS only** because its discovery, GUI launch, local paths, and service management use macOS facilities. The secure transport itself is not inherently macOS-specific, but Windows support has not been implemented or tested.

Requirements: macOS, Node.js 20 or newer, Focusrite Control 2 running locally, and a connected compatible interface.

## 🚀 Setup

```bash
git clone https://github.com/alexanderdalesio/focusrite-control-2-api.git
cd focusrite-control-2-api
npm install
npm link
```

Find the server public key advertised by Focusrite Control 2:

```bash
dns-sd -B _ocaws._tcp local.
dns-sd -L INSTANCE_NAME _ocaws._tcp local.
focusrite config set serverPublicKey 64_CHARACTER_PUBLIC_KEY
```

Pair, then optionally install the background API service:

```bash
focusrite pair
focusrite service install
```

During pairing, approve the request in Focusrite Control 2 and provide a PNG screenshot of its QR code when prompted.

## Ways to interact

### Command line

```bash
focusrite list
focusrite status
focusrite device
focusrite get dim
focusrite toggle dim
focusrite set monitor-gain -24
focusrite batch dim=on monitor-gain=-30 input1-air=on
focusrite gui
```

Append `--json` for machine-readable output. Color is used only for interactive terminal output; piping, redirection, `NO_COLOR`, and JSON output remain clean.

### HTTP API

The service listens on `127.0.0.1:41780` by default:

```bash
curl http://127.0.0.1:41780/api/v1/state

curl -X POST http://127.0.0.1:41780/api/v1/batch \
  -H 'Content-Type: application/json' \
  -d '{"operations":[{"control":"dim","value":true},{"control":"monitor-gain","value":-30}]}'
```

Convenience GET routes are available for clients that cannot send POST requests:

```text
http://127.0.0.1:41780/api/v1/control/dim/toggle
http://127.0.0.1:41780/api/v1/control/monitor-gain/-30
```

See the [HTTP API reference](docs/API.md) for every endpoint.

### Browser dashboard

Run `focusrite gui` to start the local service when necessary and open the dashboard. The interface discovers the connected device name, supports pairing, exposes connection details, and previews gain values while a slider is being adjusted.

### Presets

Create a JSON file:

```json
{
  "dim": true,
  "monitor-gain": -30,
  "input1-air": true
}
```

Apply it with `focusrite preset path/to/preset.json`. Batch and preset operations share the existing encrypted session rather than reconnecting per control.

## 🧰 Troubleshooting

```bash
focusrite doctor
focusrite ports
focusrite reconnect
focusrite logs 200
focusrite support-bundle
focusrite service status
```

See [Troubleshooting](docs/TROUBLESHOOTING.md) for recovery steps. Diagnostic bundles omit private keys, public-key values, and the device serial number; review them before sharing.

## 🔐 Security

The API binds only to `127.0.0.1` and rejects non-local browser origins. The paired X25519 private identity is stored with mode `0600` under `~/Library/Application Support/focusrite-control-2-api/`. Never publish that identity, QR payloads, device serial numbers, or unsanitized logs.

See [Security](SECURITY.md), [protocol notes](docs/PROTOCOL.md), and [contribution guidance](CONTRIBUTING.md) for details.

## Development

```bash
npm install
npm run check
npm test
```

Normal tests do not require hardware and never change interface settings. Hardware integration testing is intentionally manual.

Released under the [MIT License](LICENSE).
