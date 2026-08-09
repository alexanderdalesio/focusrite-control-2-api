import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './backend.js';
import { loadConfig, saveConfig, validateConfig, CONFIG_PATH, KEY_PATH } from './config.js';
import { discoverLocalPorts } from './discovery.js';
import { outputStyle as style } from './terminal.js';
import { searchDeviceMap } from './usb/device-map.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = join(projectRoot, 'public', 'index.html');
const browserScriptPath = join(projectRoot, 'public', 'app.js');
const packageVersion = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version;
let config = await loadConfig();
let client = null;
let lastError = null;
let pairingProcess = null;
let pairing = { state: 'idle', message: 'Use Pair when this client identity has not been approved.' };
let deviceInfoCache = null;

async function updateDiscovery() {
  if (config.backend === 'usb') return { running: false, ports: [], securePort: null, onboardingPort: null };
  const discovery = await discoverLocalPorts();
  let changed = false;
  if (discovery.securePort && discovery.securePort !== config.securePort) { config.securePort = discovery.securePort; changed = true; }
  if (discovery.onboardingPort && discovery.onboardingPort !== config.onboardingPort) { config.onboardingPort = discovery.onboardingPort; changed = true; }
  if (changed) {
    await saveConfig(config);
    if (client?.backend === 'fc2') client.updateConfig(config);
  }
  return discovery;
}

async function getClient() {
  if (config.backend === 'fc2') await updateDiscovery();
  validateConfig(config);
  if (config.backend === 'fc2' && !existsSync(KEY_PATH)) throw new Error('This installation is not paired. Run "focusrite pair" or pair from the dashboard.');
  if (!client) client = createClient(config, { logger: console });
  return client;
}

async function closeClient() {
  const active = client;
  client = null;
  await active?.close();
}

async function switchBackend(backend, replacement = null) {
  const next = replacement ?? { ...config, backend };
  next.backend = String(backend).toLowerCase();
  validateConfig(next);
  await closeClient();
  await saveConfig(next);
  config = next;
  deviceInfoCache = null;
  lastError = null;

  let discovery = { running: false, ports: [], securePort: null, onboardingPort: null };
  let device = null;
  let connectionError = null;
  try {
    discovery = await updateDiscovery();
    if (config.backend === 'fc2' && !discovery.running) throw new Error('Focusrite Control 2 is not running. Start it and use Reconnect.');
    const activeClient = await getClient();
    device = await activeClient.deviceInfo();
    deviceInfoCache = device;
  } catch (error) {
    connectionError = error.message;
    lastError = connectionError;
    await closeClient().catch(() => {});
  }
  return {
    backend: config.backend,
    connected: Boolean(device),
    device,
    ports: discovery.ports,
    error: connectionError,
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function validateLocalRequest(request) {
  const host = String(request.headers.host ?? '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host)) throw Object.assign(new Error('This API accepts localhost requests only.'), { statusCode: 403 });
  const origin = request.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) throw Object.assign(new Error('Cross-origin requests are not allowed.'), { statusCode: 403 });
}

function validateMutationRequest(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw Object.assign(new Error('Cross-site browser actions are not allowed.'), { statusCode: 403 });
  }
}

async function executeAction(rawName, rawAction, suppliedValue) {
  const activeClient = await getClient();
  const action = String(rawAction).toLowerCase();
  if (action === 'get' || action === 'status') {
    const values = await activeClient.read([rawName]);
    const name = Object.keys(values)[0];
    return { ok: true, control: name, value: values[name] };
  }
  const operation = action === 'toggle'
    ? { control: rawName, action: 'toggle' }
    : { control: rawName, value: action === 'set' ? suppliedValue : rawAction };
  const result = await activeClient.apply([operation]);
  const name = Object.keys(result.values)[0];
  return { ok: true, control: name, value: result.values[name] };
}

function beginPairing() {
  if (config.backend !== 'fc2') throw new Error('Pairing applies only to the Focusrite Control 2 backend.');
  if (pairingProcess) throw new Error('A pairing session is already active.');
  pairing = { state: 'approval', message: 'Approve the request in Focusrite Control 2.' };
  pairingProcess = spawn(process.execPath, [join(projectRoot, 'src', 'pair.js')], { cwd: projectRoot });
  let log = '';
  const receive = (chunk) => {
    log = (log + chunk).slice(-16000);
    if (/Waiting for the QR screenshot|Drag a PNG/.test(log)) pairing = { state: 'qr', message: 'Upload a PNG screenshot containing the QR code.' };
    if (/Pairing completed successfully/.test(log)) pairing = { state: 'complete', message: 'Pairing completed successfully.' };
  };
  pairingProcess.stdout.on('data', receive);
  pairingProcess.stderr.on('data', receive);
  pairingProcess.on('exit', (code) => {
    if (code !== 0 && pairing.state !== 'complete') pairing = { state: 'error', message: log.trim().split('\n').at(-1) || `Pairing exited with code ${code}.` };
    pairingProcess = null;
  });
}

async function submitQr(dataUrl) {
  if (!pairingProcess) throw new Error('Start pairing and approve the request before uploading a QR screenshot.');
  const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl ?? '');
  if (!match) throw new Error('The QR screenshot must be a PNG.');
  const path = join(tmpdir(), `focusrite-pair-${process.pid}-${Date.now()}.png`);
  await writeFile(path, Buffer.from(match[1], 'base64'), { mode: 0o600 });
  pairingProcess.stdin.write(`${path}\n`);
  pairing = { state: 'verifying', message: 'Verifying the QR code.' };
  pairingProcess.once('exit', () => unlink(path).catch(() => {}));
}

const server = http.createServer(async (request, response) => {
  try {
    validateLocalRequest(request);
    const url = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
        'X-Frame-Options': 'DENY',
      });
      response.end(await readFile(htmlPath));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(await readFile(browserScriptPath));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/health') {
      const discovery = await updateDiscovery();
      const connected = client?.connected ?? false;
      sendJson(response, 200, { ok: true, api: packageVersion, backend: config.backend, fc2Running: discovery.running, connected, paired: existsSync(KEY_PATH), lastError: connected ? null : lastError });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/controls') {
      sendJson(response, 200, { ok: true, backend: config.backend, controls: await (await getClient()).controlDefinitions() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/state') {
      const values = await (await getClient()).read();
      sendJson(response, 200, { ok: true, values });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/device') {
      const discovery = await updateDiscovery();
      const canConnect = config.backend === 'usb' || (existsSync(KEY_PATH) && discovery.running);
      if (canConnect && !deviceInfoCache) deviceInfoCache = await (await getClient()).deviceInfo();
      const device = deviceInfoCache;
      let clientPublicKey = null;
      try { clientPublicKey = JSON.parse(await readFile(KEY_PATH, 'utf8')).publicKeyHex; } catch {}
      sendJson(response, 200, {
        ok: true,
        device,
        connection: {
          backend: config.backend,
          fc2Running: discovery.running,
          connected: client?.connected ?? false,
          host: config.host,
          securePort: config.securePort,
          onboardingPort: config.onboardingPort,
          protocol: config.backend === 'usb' ? 'Focusrite Control Protocol over USB' : 'AES70/OCP.1 over authenticated WebSocket',
          serverPublicKey: config.serverPublicKey,
          clientPublicKey,
          configPath: CONFIG_PATH,
          keyPath: KEY_PATH,
        },
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/reconnect') {
      validateMutationRequest(request);
      await closeClient();
      deviceInfoCache = null;
      const discovery = await updateDiscovery();
      if (config.backend === 'fc2' && !discovery.running) throw new Error('Focusrite Control 2 is not running.');
      const activeClient = await getClient();
      const device = await activeClient.deviceInfo();
      sendJson(response, 200, { ok: true, backend: config.backend, connected: activeClient.connected, device, ports: discovery.ports });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/backend') {
      validateMutationRequest(request);
      const body = await readJson(request);
      const result = await switchBackend(body.backend);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/batch') {
      validateMutationRequest(request);
      const body = await readJson(request);
      if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 100) throw new Error('operations must contain between 1 and 100 commands.');
      const result = await (await getClient()).apply(body.operations);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/usb/device-map') {
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to inspect the device map.');
      const { map } = await activeClient.readDeviceMap();
      const matches = searchDeviceMap(map, url.searchParams.get('search') || '.').map(({ path, offset, type, width, member }) => ({
        path,
        offset,
        type,
        width,
        size: member.size ?? null,
        structSize: map.structs?.[type]?.size ?? null,
        shape: member['array-shape'],
        access: member['access-policy'] ?? 'read-write',
        notifyDevice: member['notify-device'],
      }));
      sendJson(response, 200, { ok: true, matches });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/usb/led') {
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to inspect front-panel LEDs.');
      sendJson(response, 200, { ok: true, ...await activeClient.ledInfo() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/usb/led') {
      validateMutationRequest(request);
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to control front-panel LEDs.');
      const body = await readJson(request);
      const result = await activeClient.setLed(Number(body.index), body.color);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/usb/routing') {
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to inspect routing.');
      sendJson(response, 200, { ok: true, ...await activeClient.routingState() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/usb/routing') {
      validateMutationRequest(request);
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to change routing.');
      const body = await readJson(request);
      if (typeof body.destination !== 'string' || typeof body.source !== 'string') throw new Error('destination and source are required.');
      sendJson(response, 200, { ok: true, ...await activeClient.setRouting(body.destination, body.source) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/usb/mixer/info') {
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to inspect the mixer.');
      sendJson(response, 200, { ok: true, ...await activeClient.mixerInfo() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/usb/mixer') {
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to inspect the mixer.');
      const output = url.searchParams.get('output');
      sendJson(response, 200, { ok: true, ...await activeClient.mixerState(output || undefined) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/usb/mixer') {
      validateMutationRequest(request);
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to change the mixer.');
      const body = await readJson(request);
      if (typeof body.output !== 'string' || typeof body.input !== 'string' || body.value === undefined) throw new Error('output, input, and value are required.');
      sendJson(response, 200, { ok: true, ...await activeClient.setMixerLevel(body.output, body.input, body.value) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/usb/meters') {
      const activeClient = await getClient();
      if (activeClient.backend !== 'usb') throw new Error('Select the direct USB backend to read meters.');
      sendJson(response, 200, { ok: true, ...await activeClient.meterState() });
      return;
    }
    const actionMatch = /^\/api\/v1\/control\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (actionMatch && ['GET', 'POST'].includes(request.method)) {
      if (!['get', 'status'].includes(decodeURIComponent(actionMatch[2]).toLowerCase())) validateMutationRequest(request);
      const body = request.method === 'POST' ? await readJson(request) : {};
      sendJson(response, 200, await executeAction(decodeURIComponent(actionMatch[1]), decodeURIComponent(actionMatch[2]), body.value ?? url.searchParams.get('value')));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/config') {
      sendJson(response, 200, { ok: true, config: { ...config, clientName: config.clientName } });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/config') {
      validateMutationRequest(request);
      const update = await readJson(request);
      const next = { ...config, ...update };
      validateConfig(next);
      if (next.backend !== config.backend) {
        const connection = await switchBackend(next.backend, next);
        sendJson(response, 200, { ok: true, config, connection });
      } else {
        await saveConfig(next);
        config = next;
        await closeClient();
        deviceInfoCache = null;
        sendJson(response, 200, { ok: true, config });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/pair') {
      sendJson(response, 200, { ok: true, pairing });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/pair/start') {
      validateMutationRequest(request);
      await updateDiscovery();
      beginPairing();
      sendJson(response, 202, { ok: true, pairing });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/pair/qr') {
      validateMutationRequest(request);
      await submitQr((await readJson(request)).dataUrl);
      sendJson(response, 202, { ok: true, pairing });
      return;
    }
    sendJson(response, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    lastError = error.message;
    sendJson(response, error.statusCode ?? (/not paired|not open|ECONNREFUSED/i.test(error.message) ? 503 : 400), { ok: false, error: error.message });
  }
});

server.listen(config.dashboardPort, config.dashboardHost, () => {
  console.log(`${style.success('Focusrite API and dashboard:')} ${style.accent(`http://${config.dashboardHost}:${config.dashboardPort}/`)}`);
});

server.on('error', (error) => {
  console.error(`Focusrite API server error: ${error.message}`);
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeClient().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown().finally(() => process.exit(process.exitCode ?? 0)));
}
