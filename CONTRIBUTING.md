# Contributing

Contributions are welcome, particularly verified support for additional Scarlett devices, firmware releases, Focusrite Control 2 releases, and operating systems across either communication method.

## Before opening a change

1. Do not include client private keys, serial numbers, packet captures containing personal data, or logs with secrets.
2. State whether the test used direct USB or Focusrite Control 2. Include the device model, firmware version, Node.js version, operating system, and FC2 version when applicable.
3. Prefer device-map-derived FCP controls. Keep FC2-specific AES70 object numbers in a clearly identified profile.
4. Add unit tests for parsing, validation, or control-schema changes.
5. Run `npm test` and `npm run check`.

Hardware-changing tests must be opt-in. Never enable phantom power, change monitor level, or alter routing automatically during the normal test suite.

Firmware flashing, reboot, DFU, and factory-test support is not accepted.
