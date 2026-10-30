# Changelog

## 0.4.2 - 2026-10-30

- Fixed Auto Gain configuration writes being rolled back on notification status 7. The scoped policy follows FC2's generic AppSpace behavior, requires a uniquely named event, verifies stored values, and preserves the rejected notification as a structured warning. Other write, transport, notification, and readback failures still fail normally.
- Made the undocumented peak-mode and maximum-gain settings writable with explicit experimental labels and warnings. Stored values and compatibility with silent native captures are tested; their DSP effects have not been measured with an audio signal.
- Corrected `metering-enabled` to use the separate ESP32 meter-feed field and its mapped notification, added the `front-panel-metering` alias, and left independent USB peak reads available while that feed is disabled. The unrelated legacy flag is no longer advertised as a front-panel control.
- Validated notification metadata before batch writes and retained connection-scoped capability checks for the meter feed, including concurrent discovery, reconnect, and transport-failure handling.
- Preserved warnings through single-control API actions, batches, readable CLI output, machine-safe JSON, and dashboard controls. Added experimental tooltips and amber warnings without disabling verified stored-setting writes.
- Passed 65 automated tests and 18 final live API/CLI checks, plus dashboard changes and restoration for all three remaining controls. Silent Auto Gain captures completed on both inputs; no playback or test tones were generated, and all original writable settings and the meter feed were restored.

## 0.4.1 - 2026-10-29

- Matched stale USB replies within a bounded deadline without retransmitting writes; unrecoverable transport failures now invalidate the session and return HTTP 503.
- Distinguished device-rejected optional reads from failed transport snapshots, exposed partial-state diagnostics, and made the dashboard recover from background read errors.
- Restored dotted USB gain aliases and rejected hardware-controlled output-level changes before any batch writes, with disabled dashboard dials and explanatory tooltips.
- Corrected the FC2 monitor-mute toggle and whole-dB monitor precision, adopted live AES70 gain limits, and rejected acknowledged writes whose readback does not match.
- Added transport, rollback, gain, and dashboard regressions; validated 160 complete USB snapshots and 60 complete FC2 snapshots under concurrent request load, with reversible writes and settings restoration.
- Verified FC2 v1.1210.0.0 with Scarlett firmware v4.0.2827. Documented unsupported Auto Gain configuration and front-panel metering notifications rather than guessing replacements.

## 0.4.0 - 2026-10-29

- Added hardware validation for every device-map-derived control before it is exposed to the CLI, API, or dashboard.
- Adapted numeric and enum controls to firmware-reported ranges and access policies instead of assuming the original map shape.
- Limited synthesized mute, hardware-control, and mono controls to their live array dimensions.
- Isolated unreadable controls during full-state refreshes so one changed firmware field cannot take down the dashboard or API.
- Added compatibility warnings for skipped controls and verified direct USB operation on Scarlett firmware v4.0.2827.0.
- Added `focusrite service stop` and made `service start` recover a stopped-but-installed LaunchAgent reliably.

## 0.3.1 - 2026-09-08

- Added consistent direct-USB aliases for phantom power and instrument mode, including the shorter names already accepted by the FC2 backend.
- Preserved input numbers in direct-USB control labels so similarly named controls remain distinguishable in generated clients.

## 0.3.0 - 2026-09-08

- Added explicit, authenticated LAN access for remote automation clients.
- Added `focusrite network enable|disable|status|token|rotate` management commands.
- Kept localhost access credential-free while requiring a constant-time-checked bearer token for every remote request.
- Removed access tokens from configuration API responses, normal configuration output, and support bundles.

## 0.2.1 - 2026-09-08

- Added a Homebrew tap and one-command installation for macOS users.
- Documented Homebrew installation prominently while retaining source installation for development and unsupported package-manager environments.

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
