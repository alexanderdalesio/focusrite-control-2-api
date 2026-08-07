import { WebSocketConnection, RemoteDevice, define_custom_class } from 'aes70';
import sodium from 'libsodium-wrappers';
import jsQR from 'jsqr';
import pngjs from 'pngjs';
import { OcaString } from 'aes70/src/OCP1/OcaString.js';
import { OcaUint16 } from 'aes70/src/OCP1/OcaUint16.js';
import { createType } from 'aes70/src/OCP1/createType.js';
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadConfig, KEY_PATH, validateConfig } from './config.js';
import { discoverLocalPorts } from './discovery.js';
import { errorStyle, outputStyle as style } from './terminal.js';

const { PNG } = pngjs;
const OcaBinaryString = createType({
  isConstantLength: false,
  canEncode: (value) => value instanceof Uint8Array,
  encodedLength: (value) => 2 + value.byteLength,
  encodeTo(dataView, position, value) {
    if (!(value instanceof Uint8Array) || value.byteLength > 0xffff) throw new TypeError('Invalid binary OCA string.');
    dataView.setUint16(position, value.byteLength, false);
    new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength).set(value, position + 2);
    return position + 2 + value.byteLength;
  },
});

const AuthenticationAgent = define_custom_class(
  'FocusriteAuthenticationAgent', 3, '1.2.65535.0.4878.1', 1, 'OcaAgent',
  [
    ['RequestApproval', 3, 1, [OcaBinaryString, OcaBinaryString], [OcaString]],
    ['SendQRData', 3, 2, [OcaBinaryString], [OcaString]],
    ['GetOnboardingState', 3, 3, [], [OcaString]],
    ['GetApiVersion', 3, 4, [], [OcaUint16]],
  ], [], [],
);

function rawKey(der) {
  return Buffer.from(der).subarray(-32);
}

async function loadOrCreateIdentity() {
  await mkdir(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  if (!existsSync(KEY_PATH)) {
    const pair = generateKeyPairSync('x25519');
    const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
    const privateDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
    const record = {
      algorithm: 'X25519',
      publicKeyHex: rawKey(publicDer).toString('hex'),
      publicKeyDerBase64: Buffer.from(publicDer).toString('base64'),
      privateKeyDerBase64: Buffer.from(privateDer).toString('base64'),
      createdAt: new Date().toISOString(),
    };
    await writeFile(KEY_PATH, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(KEY_PATH, 0o600);
    console.log(`${style.success('Created client identity:')} ${record.publicKeyHex}`);
    return record;
  }

  const record = JSON.parse(await readFile(KEY_PATH, 'utf8'));
  const privateKey = createPrivateKey({ key: Buffer.from(record.privateKeyDerBase64, 'base64'), type: 'pkcs8', format: 'der' });
  const derived = rawKey(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })).toString('hex');
  if (derived.toLowerCase() !== record.publicKeyHex?.toLowerCase()) throw new Error('The stored client identity is corrupt.');
  console.log(`${style.label('Reusing client identity:')} ${record.publicKeyHex}`);
  return record;
}

function normalizeInput(value) {
  value = value.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.replace(/\\ /g, ' ');
}

function decodeQr(path) {
  const png = PNG.sync.read(readFileSync(path));
  const pixels = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  const result = jsQR(pixels, png.width, png.height, { inversionAttempts: 'attemptBoth' });
  if (!result?.data) throw new Error('No readable QR code was found in the PNG.');
  return result.data.trim();
}

async function promptForQr() {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = normalizeInput(await terminal.question('\nDrag a PNG screenshot of the QR code here, then press Enter:\n> '));
      try {
        if (existsSync(answer)) return decodeQr(answer);
        if (/^[0-9a-f]+$/i.test(answer) && answer.length % 2 === 0) return answer;
        console.error(errorStyle.warning('Enter a PNG path or the hexadecimal QR payload.'));
      } catch (error) { console.error(errorStyle.error(error.message)); }
    }
  } finally { terminal.close(); }
}

export async function pair() {
  await sodium.ready;
  const discovered = await discoverLocalPorts();
  const config = { ...await loadConfig(), ...(discovered.onboardingPort ? { onboardingPort: discovered.onboardingPort } : {}) };
  validateConfig(config);
  const identity = await loadOrCreateIdentity();
  const privateKey = new Uint8Array(rawKey(Buffer.from(identity.privateKeyDerBase64, 'base64')));
  const publicKey = sodium.from_hex(identity.publicKeyHex);
  const serverKey = sodium.from_hex(config.serverPublicKey);
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const encryptedName = sodium.crypto_box_easy(sodium.from_string(config.clientName), nonce, serverKey, privateKey);
  const approvalPayload = new Uint8Array(nonce.length + encryptedName.length);
  approvalPayload.set(nonce);
  approvalPayload.set(encryptedName, nonce.length);

  let connection;
  let device;
  try {
    connection = await WebSocketConnection.connect({ url: `ws://${config.host}:${config.onboardingPort}/` });
    device = new RemoteDevice(connection, [AuthenticationAgent]);
    device.set_keepalive_interval(1);
    const members = await device.Root.GetMembers();
    const identification = members.find((member) => Number(member.ONo ?? member.MemberObjectIdentification?.ONo) === 4096);
    if (!identification) throw new Error('Focusrite Control 2 did not expose its authentication agent.');
    const authentication = device.resolve_object(identification);

    console.log(`${style.label('Authentication API version:')} ${style.value(await authentication.GetApiVersion())}`);
    const state = await authentication.GetOnboardingState();
    if (state === 'ready') {
      console.log(style.warning('Approve the request in Focusrite Control 2.'));
      const decision = await authentication.RequestApproval(publicKey, approvalPayload);
      if (decision !== 'approved') throw new Error(`The approval request was ${decision}.`);
    } else if (state !== 'scanning') {
      throw new Error(`Pairing cannot start while onboarding is ${state}.`);
    }

    console.log(style.success('Approval accepted. Waiting for the QR screenshot.'));
    const qrText = await promptForQr();
    if (!/^[0-9a-f]+$/i.test(qrText) || qrText.length % 2) throw new Error('The QR payload is not valid hexadecimal data.');
    const decision = await authentication.SendQRData(sodium.from_hex(qrText));
    if (decision !== 'approved') throw new Error(`QR verification was ${decision}.`);
    console.log(style.success('Pairing completed successfully.'));
  } finally {
    try { device?.close(); } catch {}
    try { connection?.close(); } catch {}
  }
}

if (import.meta.url === `file://${process.argv[1]}`) pair().catch((error) => { console.error(errorStyle.error(error.stack || error.message)); process.exitCode = 1; });
