# Security policy

## Sensitive files

The X25519 private identity under `~/Library/Application Support/focusrite-control-2-api/client-key.json` grants control access approved by Focusrite Control 2. Treat it as a secret. Do not attach it to issues or commit it to a repository.

## HTTP API

The API binds to `127.0.0.1` by default. `focusrite network enable` is an explicit opt-in that listens on all interfaces and requires a random bearer token for every non-loopback request. The token is stored in the user's mode-`0600` configuration file, omitted from HTTP configuration responses and support bundles, and should be treated as a password.

Use network mode only on a trusted LAN. Do not forward or publicly proxy port 41780. Rotate a disclosed token with `focusrite network rotate` or return to local-only mode with `focusrite network disable`. Browser-origin and cross-site mutation checks remain active in either mode.

## Communication methods

The application can communicate through a paired Focusrite Control 2 service or directly with the Scarlett USB control interface. Pairing credentials protect the FC2 path; operating-system device permissions protect direct USB access. Treat either method as privileged control of connected audio hardware.

## Direct hardware access

Direct USB mode can change monitor levels, phantom power, routing, mixer coefficients, and front-panel state. Run it only as a trusted user and validate automation values before applying them.

The direct transport permits a small allowlist of control/read opcodes. Firmware flashing, flash erase/write, reboot, DFU, and factory-test operations are intentionally excluded. Requests for those capabilities are out of scope for this project.

Do not run the service as root. On Linux, grant only the minimum USB permission needed for the connected Focusrite vendor/product ID.

## Reporting vulnerabilities

Please report a suspected vulnerability privately to the repository maintainer rather than opening a public issue. Include reproduction steps without real private keys, QR payloads, serial numbers, or other credentials.
