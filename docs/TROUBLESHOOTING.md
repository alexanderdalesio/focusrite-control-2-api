# Troubleshooting

Start with:

```bash
focusrite doctor
```

Add `--json` when attaching sanitized output to an issue.

## Direct USB cannot open the device

Quit Focusrite Control 2 completely, then retry:

```bash
focusrite backend usb
focusrite usb doctor
```

Direct mode needs exclusive access to the vendor control interface. It does not claim the audio streaming interfaces.

When the managed API is running in USB mode, use the normal CLI commands or `focusrite usb ...`; both reuse that service's persistent USB session. Do not launch a second standalone copy of the API against the same device.

On Linux, check USB permissions and whether a kernel driver owns the vendor interface. A narrowly scoped udev rule may be needed for vendor ID `1235`; do not run the API permanently as root. On Windows, another Focusrite process or the installed driver stack may own the interface. These platforms have not yet received real-hardware validation.

If the device is absent, reconnect its USB cable directly, avoid an unpowered hub, and confirm the configured product ID:

```bash
focusrite config show
focusrite config set usbProductId 0x821b
```

## USB commands time out

Close other software that may issue Focusrite control requests and reconnect:

```bash
focusrite reconnect
focusrite config set usbTimeout 10000
```

Do not increase the timeout indefinitely. Repeated acknowledgement timeouts usually indicate interface ownership or an unsupported device/firmware combination.

## LED colour control is unavailable

Per-index RGB and gain-halo colour control is not supported on the tested Scarlett 16i16 4th Gen firmware. The device map contains an internal `setLED` command buffer and a maximum array-size constant, but those values do not describe user-addressable physical LEDs. Earlier builds incorrectly treated the constant as a physical LED count and could report success after the firmware merely retained the command buffer.

Check the detected capability and inspect the raw map metadata with:

```bash
focusrite usb led info
focusrite usb map 'led|halo|colou?r|brightness'
```

The CLI refuses LED colour writes rather than reporting an unverified visual change. Hardware testing showed that both mapped LED notification paths could temporarily re-enumerate the USB control processor without changing a visible LED, so mutation probes are intentionally not shipped.

`focusrite usb led info` also reports the separate ESP32 front-panel controller's firmware, IPC version, encryption mode, reset reason, and current state. These are read-only diagnostics.

## Routing or mixer names are rejected

Read the names reported by this device:

```bash
focusrite usb routing list
focusrite usb mixer list
```

Quote names containing spaces. Fixed mixer-input routes cannot be changed and are identified as fixed in routing output.

## Focusrite Control 2 was restarted

The FC2 backend normally rediscovers its ports and reconnects automatically:

```bash
focusrite backend fc2
focusrite reconnect
focusrite ports
```

On non-macOS platforms, automatic FC2 process/port discovery is not yet implemented; configure the advertised ports directly.

## Pairing is missing or rejected

Confirm the current server public key, update it, and pair again:

```bash
dns-sd -B _ocaws._tcp local.
dns-sd -L INSTANCE_NAME _ocaws._tcp local.
focusrite config set serverPublicKey 64_CHARACTER_PUBLIC_KEY
focusrite pair
```

Approve the request in FC2 before submitting the QR screenshot. Keep the complete QR code and a small white margin visible.

## API or dashboard is unavailable

Run it in the foreground for immediate errors:

```bash
focusrite api
```

On macOS, the optional managed service provides:

```bash
focusrite service status
focusrite service restart
focusrite logs 200
```

The CLI synchronizes backend changes with the running API and restarts an outdated managed service on macOS. If a manually started copy is still serving an older build, stop that process and run:

```bash
focusrite service restart
focusrite doctor
```

`doctor` performs a live state read; it does not treat cached device metadata as a working control connection.

## Do not test unknown writes blindly

Stop if the model, firmware, map dimensions, or ranges differ unexpectedly. Do not use raw USB tools to probe firmware, boot, DFU, or factory-test commands.

## Create a support bundle

```bash
focusrite support-bundle
```

The generated JSON omits private keys, public-key values, and device serial numbers. Review it before sharing it.
