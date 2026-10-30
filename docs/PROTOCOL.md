# Architecture and protocol notes

## Compatibility boundary

Real-hardware validation currently covers:

- Focusrite Control 2 v1.1081.0.0
- Focusrite Control 2 v1.1210.0.0
- Scarlett 16i16 4th Gen firmware v3.0.2778.0 (FCP build 2778)
- Scarlett 16i16 4th Gen firmware v4.0.2827.0 (FCP build 2827)
- macOS

The hardware-free suite runs on macOS, Linux, and Windows. Treat direct control on other devices and platforms as experimental until it is verified.

## Communication model

The application is a dual-transport Scarlett controller. It has one public control interface and two communication methods:

- `usb` communicates directly with the Scarlett's vendor interface using Focusrite Control Protocol.
- `fc2` communicates as an approved remote controller through the local Focusrite Control 2 service using AES70/OCP.1.

The API server retains the selected transport. Commands are serialized on that persistent connection, so a batch does not claim the USB interface or authenticate a WebSocket for every value.

## Direct USB transport

The Scarlett 16i16 exposes audio interfaces separately from a vendor-specific control interface. Direct mode claims only the vendor interface; normal Core Audio endpoints remain outside this implementation. Focusrite Control 2 must be closed because it competes for the same control interface.

FCP commands use USB class/interface control transfers and a separate interrupt-IN acknowledgement:

```text
little-endian command header (16 bytes)
u32 opcode | u16 payload size | u16 sequence | u32 error | u32 padding
```

Initialization performs step zero, opcode `0x000000`, then opcode `0x000002`. Every later command is matched by opcode and sequence; response size and device error status are validated.

The firmware supplies a compressed JSON device map. This project resolves control offsets, primitive widths, array indexes, limits, access policies, notification IDs, routing pins, mixer indexes, and meter indexes from that map instead of embedding firmware addresses. Controls whose type or index no longer matches the live map are omitted, and ranges are constrained to the device's current declaration. Device-rejected optional reads produce an explicitly partial snapshot; transport errors invalidate the entire snapshot and session. Older queued responses are drained within a bounded deadline without replaying writes.

Auto Gain mean/peak targets require a narrow acknowledgment exception on the tested firmware. Ghidra inspection of FC2 v1.1210.0.0 shows `StandardAutoGainTargetLevelBehaviour::set` (`0x10012d600`) setting mean attenuation and a peak ceiling 6 dB above it. `AppSpace::setAndNotifyDevice` writes the field and sends its declared notification. The `Device::notify` adapter (`0x1000e0d04`) discards the USB command's returned status. Firmware v4.0.2827 returns status 7 for target notifications even though the fields change. Treating this as a failed setter and rolling back undid the requested target.

The client retains verified Auto Gain configuration writes on that specific notification status, and only when the event matches its expected uniquely named enum. Other notification errors, data-write errors, transport failures, and failed readback still fail the operation. A structured warning preserves the rejected notification status. This is not a blanket error suppression rule. The numeric meaning of status 7 has not been established. Live CLI/API writes and FC2 preference changes were cross-checked on the tested device; no acoustic calibration accuracy is claimed.

The undocumented `autogainUsePeak` and `autogainSetMaxGain` fields use this same stored-setting policy, but are explicitly experimental. Their writes, readback, restoration, and compatibility with silent native captures were tested; their processing effect was not measured. FC2's Ghidra-defined string inventory has no direct literal hits for those names. The exact bundled XMOS v4.0.2827 payload is marked encrypted in the vendor manifest, so it was not disassembled as plaintext or treated as evidence of DSP semantics.

The actual front-panel meter-feed control is `meterDataToESP32`, with `eMSG_ENABLE_METERING` (27 on the tested map). It accepts its notification, holds a changed value, and restores normally. `metering-enabled` now resolves that field rather than the unrelated `meteringEnabled` member/event 20. No offsets or replacement event numbers are hard-coded. Feed capability is checked using the current value once per connection; rejected or ambiguous metadata makes the control read-only. USB peaks continue while the feed is disabled. FC2's `startMetering`/`stopMetering` schedule and cancel host polling, rather than toggling either hardware flag.

FC2 also has a parameter-buffer write path, with metadata-selected index/value fields and `parameterChannel`/`parameterValue` defaults. The tested map does not select it for these controls, and a bounded runtime comparison did not resolve the rejected notifications. It is not used as a speculative fallback.

Specialized FCP categories provide:

- routing: three complete mux tables for the supported sample-rate families
- mixer: 12 outputs × 36 input coefficients on the tested device
- meters: 64 raw peak slots, mapped back to device-provided source and destination names

The map also declares LED test buffers on the USB control processor. On the tested 16i16, their values are retained but do not reach the separate ESP32 front-panel renderer; notifying either path can temporarily re-enumerate the USB device. They are therefore exposed only through read-only diagnostics, not as control operations.

Routing writes preserve the destination pin, replace only its source pin, update every table where the destination exists, then read the tables back. Mixer writes first read the complete row, replace one coefficient, write the row, and verify it. A raw mixer coefficient of 32613 represents +12 dB; zero is mute.

Only explicitly allowed read/control opcodes can be sent. Reboot, flash info/erase/write, DFU, and factory-test actions are absent from the allowlist and rejected before USB I/O.

The packet layout was cross-checked against the Linux FCP driver and `fcp-support` work by Geoffrey D. Bennett. This implementation is independently structured for the Node API and intentionally excludes the update paths present in lower-level tooling.

## Focusrite Control 2 discovery and pairing

FC2 advertises `_ocaws._tcp.local` through Bonjour. In the tested release it exposes an onboarding WebSocket and a secure-control WebSocket. Ports can change after a restart, so macOS discovery refreshes them before reconnecting.

The onboarding endpoint exposes a Focusrite authentication agent through AES70. A client creates an X25519 identity, encrypts its display name for the server identity, requests approval, and submits the payload decoded from the QR code shown by FC2.

The private client identity remains local. Only its public identity is placed in the secure WebSocket path.

## FC2 secure transport

After the WebSocket upgrade, both peers establish XChaCha20-Poly1305 secretstreams. FC2 v1.1081.0.0 uses the `sharedRx` result from `crypto_kx_client_session_keys` in both directions. The peers exchange and echo 32-byte session nonces before AES70 data begins.

Encrypted records use a two-byte big-endian length followed by secretstream ciphertext. The first outbound payload also contains the secretstream header. AES70 plaintext is split at 1283 bytes per record.

The FC2 transport discards its session after a transport error. The next operation reconnects with the approved identity. Toggles are resolved to explicit values before a retry, preventing an ambiguous double toggle.
