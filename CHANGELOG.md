# Changelog

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
