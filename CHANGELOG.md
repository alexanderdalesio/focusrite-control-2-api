# Changelog

## 0.2.0 - 2026-08-08

Dual-communication release: one CLI, HTTP API, and dashboard can control a Scarlett either directly over USB/FCP or through an authenticated Focusrite Control 2 session.

- Established the dual-communication architecture with direct USB/FCP and authenticated Focusrite Control 2 transports behind one control interface.
- Added mapped settings on the tested Scarlett, including talkback, Auto Gain targets, mono modes, metering, and ADAT expansion.
- Added verified routing control across all three sample-rate tables.
- Added verified 12×36 internal mixer reads and writes.
- Added 64-slot meter reads with named source and destination channels.
- Added direct routing, mixer, and meter controls to the CLI and HTTP API.
- Simplified the browser dashboard around collapsible input and output groups, with vertically draggable rotary controls and live value previews.
- Split interface-wide controls into Auto Gain, Talkback, output-control, and interface sections; widened control-column spacing and flattened the rotary-dial styling.
- Grouped every per-channel monitor and headphone control into its corresponding stereo output panel.
- Ordered every panel by control purpose, paired levels with their matching mute controls, shortened redundant labels, and prioritized the main monitoring and I/O panels.
- Stacked stereo level and mute controls by channel, and added transactional backend switching through the GUI, HTTP API, and `focusrite backend` command.
- Prevented completed FC2 pairing state from re-reading and dimming every control on each status poll, and made the pairing-panel toggle visibly change to “Close pairing” while open.
- Kept two-second USB/FC2 metadata and control polling while applying only changed values, preserving focused fields and avoiding global busy-state flashes during background refreshes.
- Arranged the two main Monitor dials on one row with their matching toggles directly below.
- Grouped CLI help by purpose, aligned variable-length output, replaced internal diagnostic identifiers with readable labels, and strengthened support-log redaction.
- Added a backend factory and persistent direct USB sessions for efficient batches.
- Added communication-method synchronization and automatic managed-service restarts so the GUI cannot remain attached to a stale single-transport process after switching methods.
- Routed explicit `focusrite usb` commands through the persistent local API when it owns the USB interface, preventing competing libusb claims.
- Removed unsafe LED mutation probes after hardware testing showed that the acknowledged map buffers did not change visible LEDs and their notification events could temporarily re-enumerate the USB device.
- Added read-only ESP32 front-panel firmware, IPC, encryption, reset, and state diagnostics to `focusrite usb led info`.
- Made diagnostics verify a live control-state read and suppress stale connection errors after recovery.
- Added cross-platform configuration paths, dashboard launching, and CI; real-hardware testing remains macOS-only.
- Excluded firmware, reboot, DFU, and factory-test operations from the FCP command allowlist.

## 0.1.0 - 2026-08-06

- Added authenticated pairing for Focusrite Control 2.
- Added persistent secure AES70 transport with keepalive and automatic reconnect.
- Added batched reads, writes, toggle resolution, and verification.
- Added CLI, JSON HTTP API, presets, convenience URL actions, and macOS login service.
- Added restrained terminal colors with automatic plain output for pipes, JSON, and `NO_COLOR`.
- Added browser controls with dynamic device identity and connection diagnostics.
- Added connection diagnostics, log inspection, reconnect, port discovery, and redacted support-bundle commands.
- Fixed gain sliders so the selected value is preserved while the request is submitted.
- Added a live decibel preview while dragging or adjusting gain sliders.
- Clarified that the current client implementation supports macOS, while Focusrite Control 2 itself is also available for Windows.
- Documented the tested Focusrite Control 2, device, and firmware versions.
