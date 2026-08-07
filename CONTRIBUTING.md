# Contributing

Contributions are welcome, particularly verified control profiles for other Focusrite devices and software releases.

## Before opening a change

1. Do not include client private keys, serial numbers, packet captures containing personal data, or logs with secrets.
2. State the Focusrite Control 2 version, device model, firmware version, Node.js version, and macOS version used for testing.
3. Keep device-specific object numbers in a clearly identified profile or control map.
4. Add unit tests for parsing, validation, or control-schema changes.
5. Run `npm test` and `npm run check`.

Hardware-changing tests must be opt-in. Never enable phantom power, change monitor level, or alter routing automatically during the normal test suite.
