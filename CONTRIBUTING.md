# Contributing

Contributions are welcome, particularly verified control profiles for other Focusrite devices and software releases.

## Before opening a change

1. Do not include client private keys, serial numbers, packet captures containing personal data, or logs with secrets.
2. State the backend, Focusrite Control 2 version when applicable, device model, firmware version, Node.js version, and operating system used for testing.
3. Prefer device-map-derived FCP controls. Keep FC2-specific AES70 object numbers in a clearly identified profile.
4. Add unit tests for parsing, validation, or control-schema changes.
5. Run `npm test` and `npm run check`.

Hardware-changing tests must be opt-in. Never enable phantom power, change monitor level, or alter routing automatically during the normal test suite.

Firmware flashing, reboot, DFU, and factory-test support is not accepted.
