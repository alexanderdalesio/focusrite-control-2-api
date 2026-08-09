# Security policy

## Sensitive files

The X25519 private identity under `~/Library/Application Support/focusrite-control-2-api/client-key.json` grants control access approved by Focusrite Control 2. Treat it as a secret. Do not attach it to issues or commit it to a repository.

## Local API

The API binds to `127.0.0.1` and rejects non-local browser origins. Do not proxy or expose port 41780 to another machine or the public internet. State-changing GET endpoints exist only for local clients with limited HTTP support.

## Direct hardware access

Direct USB mode can change monitor levels, phantom power, routing, mixer coefficients, and front-panel state. Run it only as a trusted local user, keep API access local, and validate automation values before applying them.

The direct transport permits a small allowlist of control/read opcodes. Firmware flashing, flash erase/write, reboot, DFU, and factory-test operations are intentionally excluded. Requests for those capabilities are out of scope for this project.

Do not run the service as root. On Linux, grant only the minimum USB permission needed for the connected Focusrite vendor/product ID.

## Reporting vulnerabilities

Please report a suspected vulnerability privately to the repository maintainer rather than opening a public issue. Include reproduction steps without real private keys, QR payloads, serial numbers, or other credentials.
