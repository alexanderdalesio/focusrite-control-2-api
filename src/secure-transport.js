import sodium from 'libsodium-wrappers';
import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { RemoteDevice } from 'aes70';
import { WebSocketConnectionBase } from 'aes70/src/controller/websocket_connection_base.js';

const RECORD_PLAINTEXT_LIMIT = 1283;

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms.`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class FocusriteSecureConnection extends WebSocketConnectionBase {
  constructor(webSocket, options, key) {
    super(webSocket, options);
    this.key = key;
    this.receiveBuffer = new Uint8Array(0);
    this.pullState = null;
    this.sentHeader = false;
    this.handshakeStage = 0;
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const push = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
    this.pushState = push.state;
    this.pushHeader = push.header;
    this.localNonce = sodium.randombytes_buf(32);
    this.write(this.localNonce);

    this.on('close', () => {
      this.closed = true;
      if (this.handshakeStage < 2) this.rejectReady(new Error('The secure session closed during authentication.'));
    });
  }

  read(data) {
    const incoming = new Uint8Array(data);
    const combined = new Uint8Array(this.receiveBuffer.length + incoming.length);
    combined.set(this.receiveBuffer);
    combined.set(incoming, this.receiveBuffer.length);
    this.receiveBuffer = combined;

    if (!this.pullState) {
      const headerLength = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
      if (this.receiveBuffer.length < headerLength) return;
      this.pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(this.receiveBuffer.slice(0, headerLength), this.key);
      this.receiveBuffer = this.receiveBuffer.slice(headerLength);
    }

    while (this.receiveBuffer.length >= 2) {
      const recordLength = (this.receiveBuffer[0] << 8) | this.receiveBuffer[1];
      if (this.receiveBuffer.length < recordLength + 2) return;
      const encrypted = this.receiveBuffer.slice(2, recordLength + 2);
      this.receiveBuffer = this.receiveBuffer.slice(recordLength + 2);
      this.#readRecord(encrypted);
    }
  }

  #readRecord(encrypted) {
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(this.pullState, encrypted);
    if (!result) throw new Error('Focusrite Control 2 sent a record that failed authentication.');
    const message = result.message;

    if (this.handshakeStage === 0) {
      if (message.length !== 32 || sodium.memcmp(message, this.localNonce)) throw new Error('The server session nonce is invalid.');
      this.serverNonce = message;
      this.handshakeStage = 1;
      this.write(message);
      return;
    }
    if (this.handshakeStage === 1) {
      if (message.length !== 32 || !sodium.memcmp(message, this.localNonce)) throw new Error('Focusrite Control 2 did not confirm the client nonce.');
      this.handshakeStage = 2;
      this.resolveReady();
      return;
    }

    super.read(message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength));
  }

  write(data) {
    const bytes = new Uint8Array(data);
    const headerLength = this.sentHeader ? 0 : this.pushHeader.length;
    const records = [];
    let byteLength = headerLength;

    for (let offset = 0; offset < bytes.length; offset += RECORD_PLAINTEXT_LIMIT) {
      const chunk = bytes.subarray(offset, Math.min(offset + RECORD_PLAINTEXT_LIMIT, bytes.length));
      const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
        this.pushState,
        chunk,
        null,
        sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      );
      records.push(encrypted);
      byteLength += 2 + encrypted.length;
    }

    const framed = new Uint8Array(byteLength);
    if (!this.sentHeader) {
      framed.set(this.pushHeader);
      this.sentHeader = true;
    }
    let position = headerLength;
    for (const encrypted of records) {
      framed[position] = encrypted.length >>> 8;
      framed[position + 1] = encrypted.length & 0xff;
      framed.set(encrypted, position + 2);
      position += encrypted.length + 2;
    }
    this.ws.send(framed);
    this.last_tx_time = this._now();
    this.tx_bytes += bytes.byteLength;
  }

  _now() {
    return performance.now();
  }

  static connect(url, key) {
    return new Promise((resolve, reject) => {
      const webSocket = new WebSocket(url, { origin: 'capacitor://localhost', perMessageDeflate: true });
      const onError = (error) => reject(error);
      webSocket.once('error', onError);
      webSocket.once('unexpected-response', (_request, response) => reject(new Error(`Secure WebSocket upgrade returned HTTP ${response.statusCode}.`)));
      webSocket.once('open', () => {
        webSocket.off('error', onError);
        resolve(new this(webSocket, { url }, key));
      });
    });
  }
}

export async function createSecureSession({ host, port, serverPublicKey, keyPath, timeoutMs = 4000 }) {
  await sodium.ready;
  const record = JSON.parse(await readFile(keyPath, 'utf8'));
  if (!/^[0-9a-f]{64}$/i.test(record.publicKeyHex ?? '')) throw new Error(`The client key at ${keyPath} is invalid.`);

  const clientPublicKey = sodium.from_hex(record.publicKeyHex);
  const clientPrivateKey = new Uint8Array(Buffer.from(record.privateKeyDerBase64, 'base64').subarray(-32));
  if (!sodium.memcmp(sodium.crypto_scalarmult_base(clientPrivateKey), clientPublicKey)) throw new Error('The stored client public and private keys do not match.');

  const keys = sodium.crypto_kx_client_session_keys(clientPublicKey, clientPrivateKey, sodium.from_hex(serverPublicKey));
  // FC2 v1.1081.0.0 uses the client receive key for both secretstream directions.
  const connection = await FocusriteSecureConnection.connect(`ws://${host}:${port}/${record.publicKeyHex}`, keys.sharedRx);
  await withTimeout(connection.ready, timeoutMs, 'Secure session authentication');
  const device = new RemoteDevice(connection);
  device.set_keepalive_interval(1);
  connection.flush();
  return { connection, device, clientPublicKey: record.publicKeyHex };
}

export { withTimeout };
