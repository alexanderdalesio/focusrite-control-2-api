# 🎛️ Focusrite Control API

[![CI](https://github.com/alexanderdalesio/focusrite-control-2-api/actions/workflows/ci.yml/badge.svg)](https://github.com/alexanderdalesio/focusrite-control-2-api/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853d)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An unofficial local controller for Focusrite interfaces with a CLI, JSON API, and browser dashboard. It offers two communication methods behind one consistent control surface: direct USB/FCP access to the interface, or authenticated communication through Focusrite Control 2.

> [!IMPORTANT]
> Hardware testing is limited to **Focusrite Control 2 v1.1081.0.0** and a **Scarlett 16i16 4th Gen running firmware v3.0.2778.0 on macOS**. Other models, firmware, and operating systems are unverified.

This independent project is **not affiliated with or endorsed by Focusrite Audio Engineering Limited**. Focusrite and Scarlett are trademarks of their respective owner.

## 🍺 Install with Homebrew

```bash
brew install alexanderdalesio/tap/focusrite-control-api
```

Homebrew installs the `focusrite` command and its Node.js runtime dependency. Upgrade later with `brew upgrade focusrite-control-api`.

## Features

- Direct Focusrite Control Protocol (FCP) access over the vendor USB interface
- Device-map-driven controls instead of hard-coded memory offsets
- Preamp gain, Air modes, phantom power, instrument mode, Clip Safe, Auto Gain, monitor controls, talkback, mono modes, and more
- Complete routing-table reads and verified routing writes at all supported sample-rate modes
- 12×36 internal mixer control with mute to +12 dB levels
- 64-slot signal-meter reads with device-provided channel names
- Persistent connections and multi-control batches through the local API service
- Human-readable CLI output, machine-safe `--json`, presets, diagnostics, and a dynamic browser dashboard
- Authenticated Focusrite Control 2 communication for workflows that need the official application open

Firmware update, flash erase/write, reboot, DFU, and factory-test commands are deliberately not implemented.

## Stream Deck

The companion [Focusrite Control for Stream Deck](https://github.com/alexanderdalesio/focusrite-control-stream-deck) plugin provides ready-made keys and dial actions for monitor, input, headphone, connection, and batch controls. Download its double-click installer from the [latest release](https://github.com/alexanderdalesio/focusrite-control-stream-deck/releases/latest).

## Choose a communication method

| Method | Communication path | Focusrite Control 2 | Control surface |
| --- | --- | --- | --- |
| `fc2` | Authenticated AES70/WebSocket controller | Must be open and paired | Core preamp and monitor controls exposed by FC2 |
| `usb` | Focusrite Control Protocol over the vendor USB interface | Must be closed | Expanded device-map controls plus routing, mixer, meters, and diagnostics on the tested Scarlett |

Both methods are first-class parts of the application. They use the same ordinary `focusrite get`, `set`, `toggle`, and `batch` commands, along with the same HTTP API and dashboard. Select either method at runtime:

```bash
focusrite backend fc2
focusrite backend usb
```

Switching closes the active transport before opening the selected one. Direct USB offers the wider control surface on the tested 16i16. The FC2 method is designed for coexistence with the official application and exposes the controls published by FC2.

## Platform support

The direct backend uses libusb and is designed for macOS, Linux, and Windows. CI runs the hardware-free test suite on all three, but **only macOS has been tested with real hardware**. Linux permissions or an attached kernel driver and Windows driver ownership may require platform-specific setup.

The optional `focusrite service` login-service command is macOS-only. On Linux or Windows, run `focusrite api` with your normal process manager. The dashboard launcher itself is cross-platform.

Requirements: Node.js 20 or newer and a supported Focusrite USB interface.

## Install from source

Homebrew is the recommended installation method on macOS. To develop the project or install it without Homebrew:

```bash
git clone https://github.com/alexanderdalesio/focusrite-control-2-api.git
cd focusrite-control-2-api
npm install
npm link
```

### Direct USB communication

Quit Focusrite Control 2 first—direct USB needs exclusive access to the vendor control interface—then select it:

```bash
focusrite backend usb
focusrite doctor
focusrite device
focusrite gui
```

The tested Scarlett product ID is the default. Another product can be selected explicitly:

```bash
focusrite config set usbProductId 0x821b
```

### Focusrite Control 2 communication

Keep FC2 running, select it as the communication method, configure the public key advertised over Bonjour, and pair this controller:

```bash
focusrite backend fc2
dns-sd -B _ocaws._tcp local.
dns-sd -L INSTANCE_NAME _ocaws._tcp local.
focusrite config set serverPublicKey 64_CHARACTER_PUBLIC_KEY
focusrite pair
```

Approve the request in Focusrite Control 2, then provide a PNG screenshot of its QR code when prompted.

## Command line

Ordinary commands use the selected communication method:

```bash
focusrite list
focusrite status
focusrite get dim
focusrite toggle dim
focusrite set monitor-gain -24
focusrite batch dim=on monitor-gain=-30 input1-air=presence-drive
focusrite preset settings.json
focusrite gui
```

Useful connection and diagnostic commands:

```bash
focusrite backend fc2          # communicate through the paired FC2 service
focusrite backend usb          # communicate directly over USB/FCP
focusrite device               # connected device and firmware
focusrite doctor               # readable connection checks
focusrite reconnect            # rebuild the selected transport
focusrite list                 # controls available through the selected method
```

Direct USB tools expose routing, mixer, meters, and device-map diagnostics:

```bash
focusrite usb routing list
focusrite usb routing set "Monitor 3" "USB 3"
focusrite usb mixer get "Mixer 1"
focusrite usb mixer set "Mixer 1" "Analogue 1" -6
focusrite usb meters
focusrite usb map 'air|gain|mute'
focusrite usb led info
```

The tested 16i16 firmware exposes LED test buffers on its USB control processor, but acknowledged writes do not reach the separate ESP32 front-panel renderer. Notifying those buffers can temporarily re-enumerate the USB device. The project therefore rejects colour writes and limits `focusrite usb led info` to safe, read-only controller diagnostics.

Append `--json` for machine-readable output. Human output uses aligned columns, readable diagnostic labels, and restrained terminal colors. Colors are disabled for JSON, redirection, pipes, and `NO_COLOR`.

## Local API and dashboard

`focusrite gui` starts the local service if needed and opens a focused hardware-control dashboard. Inputs, outputs, ranges, and device identity come from the connected interface. Numeric controls use vertically draggable rotary dials; input and output groups can be collapsed. Routing, mixer, and meter operations remain available through the CLI and HTTP API.

The API binds to `127.0.0.1:41780` by default:

```bash
curl http://127.0.0.1:41780/api/v1/state

curl -X POST http://127.0.0.1:41780/api/v1/batch \
  -H 'Content-Type: application/json' \
  -d '{"operations":[{"control":"dim","value":true},{"control":"monitor-gain","value":-30}]}'
```

The service keeps the selected USB or encrypted FC2 session open. Batch operations reuse that session instead of reconnecting for every control. See the [HTTP API reference](docs/API.md).

### Authenticated network access

Localhost-only access is the default. To let another trusted computer—such as a Windows PC running Stream Deck—control the API on this Mac, enable its authenticated LAN listener:

```bash
focusrite network enable
```

The command prints reachable IPv4 URLs and a generated access token. Supply both to the remote client. Remote requests must send `Authorization: Bearer TOKEN`; requests without the exact token are rejected. Useful management commands are:

```bash
focusrite network status
focusrite network token
focusrite network rotate
focusrite network disable
```

The local dashboard and CLI remain accessible without a token from the Mac itself. Network mode listens on all interfaces, so use it only on a trusted LAN, keep the token private, and do not forward port `41780` from your router.

## 🧰 Troubleshooting

```bash
focusrite doctor
focusrite usb doctor
focusrite reconnect
focusrite logs 200
focusrite support-bundle
```

See [Troubleshooting](docs/TROUBLESHOOTING.md), [protocol notes](docs/PROTOCOL.md), and [Security](SECURITY.md). Diagnostic bundles exclude private keys, public-key values, and device serial numbers; review any bundle before sharing it.

## Development

```bash
npm install
npm run check
npm test
```

Normal tests are hardware-free and never change interface settings. Hardware integration tests remain explicit and manual.

Released under the [MIT License](LICENSE).
