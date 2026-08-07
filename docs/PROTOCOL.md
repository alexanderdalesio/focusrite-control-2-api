# Architecture and protocol notes

## Compatibility boundary

Development and hardware testing were performed only with:

- Focusrite Control 2 v1.1081.0.0
- Scarlett 16i16 4th Gen firmware v3.0.2778.0
- macOS

The implementation should be treated as experimental outside that combination. Focusrite Control 2 is also available for Windows, and the secure transport is not inherently macOS-specific. This repository currently depends on macOS-specific process discovery and service management, so Windows remains unsupported until those integrations are implemented and tested.

## Local services

Focusrite Control 2 advertises `_ocaws._tcp.local` through Bonjour. In the tested release, it exposes an onboarding WebSocket and a secure control WebSocket. The port numbers can change between launches, so the service discovers the current listening ports from the local process before reconnecting.

## Pairing

The onboarding endpoint exposes a Focusrite authentication agent through AES70. A client creates an X25519 identity, encrypts its display name for the server identity, requests approval, and submits the payload decoded from the QR code shown by Focusrite Control 2.

The private client identity remains on the local Mac. Only the public identity appears in the secure WebSocket path.

## Secure transport

After the WebSocket upgrade, both peers establish XChaCha20-Poly1305 secretstreams. The tested Focusrite Control 2 release uses the `sharedRx` output from `crypto_kx_client_session_keys` in both directions. The peers exchange and echo 32-byte session nonces before sending AES70 data.

Encrypted records use a two-byte big-endian length followed by the secretstream ciphertext. The first outbound payload also contains the secretstream header. AES70 plaintext is split at 1283 bytes per record.

## Command lifecycle

The background service keeps the authenticated WebSocket alive instead of reconnecting for each action. Commands are serialized at the API boundary, while commands inside one requested batch are scheduled together and flushed once. Verification reads are also batched.

The service drops its session after any transport error. The next operation reconnects with the existing paired identity. Toggle operations are resolved to explicit values before write retries, avoiding ambiguous double toggles.

## Object mappings

The current control map uses AES70 object numbers discovered from the Scarlett 16i16 4th Gen object tree. Device identity comes from string sensors 4097 (product), 4099 (serial), and 4100 (firmware). Control object numbers are kept in `src/controls.js` so support for other models can be introduced through model-specific profiles later.
