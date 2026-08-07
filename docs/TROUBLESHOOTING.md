# Troubleshooting

Start with:

```bash
focusrite doctor
```

The command checks Node.js, the Focusrite Control 2 process, discovered ports, server-key configuration, paired identity, background API, and a live secure device-information read.

## Focusrite Control 2 was restarted

The next command normally reconnects automatically. Force a clean session when needed:

```bash
focusrite reconnect
```

If that fails, verify the current ports:

```bash
focusrite ports
lsof -nP -iTCP -sTCP:LISTEN | grep -i focusrite
```

## API service is unavailable

```bash
focusrite service status
focusrite service restart
focusrite logs 200
```

Reinstall the login service if its repository path changed:

```bash
focusrite service install
```

## Pairing is missing or rejected

Confirm the server public key from the `_ocaws._tcp` Bonjour record, update it, and pair again:

```bash
dns-sd -B _ocaws._tcp local.
dns-sd -L INSTANCE_NAME _ocaws._tcp local.
focusrite config set serverPublicKey 64_CHARACTER_PUBLIC_KEY
focusrite pair
```

Approve the request in Focusrite Control 2 before submitting the QR screenshot. Keep the entire QR code visible with a small margin around it.

## Commands use unexpected object mappings

Stop. Do not test writes blindly on another device or firmware. The object mapping is verified only for Focusrite Control 2 v1.1081.0.0 with Scarlett 16i16 4th Gen firmware v3.0.2778.0.

## Create a support bundle

```bash
focusrite support-bundle
```

The generated JSON omits the private key, public-key values, and device serial number. Review it before attaching it to an issue.
