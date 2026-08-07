import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FocusriteClient } from './client.js';
import { CONTROLS, normalizeControlName, publicControlDefinitions } from './controls.js';
import { loadConfig, saveConfig, validateConfig, CONFIG_PATH, KEY_PATH } from './config.js';
import { discoverLocalPorts } from './discovery.js';
import { outputStyle as style } from './terminal.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = join(projectRoot, 'public', 'index.html');
const browserScriptPath = join(projectRoot, 'public', 'app.js');
let config = await loadConfig();
let client = null;
let lastError = null;
let pairingProcess = null;
let pairing = { state: 'idle', message: 'Use Pair when this client identity has not been approved.' };
let deviceInfoCache = null;

async function updateDiscovery() {
  const discovery = await discoverLocalPorts();
  let changed = false;
  if (discovery.securePort && discovery.securePort !== config.securePort) { config.securePort = discovery.securePort; changed = true; }
  if (discovery.onboardingPort && discovery.onboardingPort !== config.onboardingPort) { config.onboardingPort = discovery.onboardingPort; changed = true; }
  if (changed) {
    await saveConfig(config);
    client?.updateConfig(config);
  }
  return discovery;
}

async function getClient() {
  await updateDiscovery();
  validateConfig(config);
  if (!existsSync(KEY_PATH)) throw new Error('This installation is not paired. Run "focusrite pair" or pair from the dashboard.');
  if (!client) client = new FocusriteClient(config, { keyPath: KEY_PATH, logger: console });
  return client;
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
  const name = normalizeControlName(rawName);
  const action = String(rawAction).toLowerCase();
  if (action === 'get' || action === 'status') {
    const values = await (await getClient()).read([name]);
    return { ok: true, control: name, value: values[name] };
  }
  const operation = action === 'toggle'
    ? { control: name, action: 'toggle' }
    : { control: name, value: action === 'set' ? suppliedValue : rawAction };
  const result = await (await getClient()).apply([operation]);
  return { ok: true, control: name, value: result.values[name] };
}

function beginPairing() {
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
      sendJson(response, 200, { ok: true, api: '0.1.0', fc2Running: discovery.running, connected: client?.connected ?? false, paired: existsSync(KEY_PATH), lastError });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/controls') {
      sendJson(response, 200, { ok: true, controls: publicControlDefinitions() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/state') {
      const values = await (await getClient()).read();
      sendJson(response, 200, { ok: true, values });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/device') {
      const discovery = await updateDiscovery();
      if (existsSync(KEY_PATH) && discovery.running && !deviceInfoCache) deviceInfoCache = await (await getClient()).deviceInfo();
      const device = deviceInfoCache;
      let clientPublicKey = null;
      try { clientPublicKey = JSON.parse(await readFile(KEY_PATH, 'utf8')).publicKeyHex; } catch {}
      sendJson(response, 200, {
        ok: true,
        device,
        connection: {
          fc2Running: discovery.running,
          connected: client?.connected ?? false,
          host: config.host,
          securePort: config.securePort,
          onboardingPort: config.onboardingPort,
          protocol: 'AES70/OCP.1 over authenticated WebSocket',
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
      client?.close();
      client = null;
      deviceInfoCache = null;
      const discovery = await updateDiscovery();
      if (!discovery.running) throw new Error('Focusrite Control 2 is not running.');
      const activeClient = await getClient();
      const device = await activeClient.deviceInfo();
      sendJson(response, 200, { ok: true, connected: activeClient.connected, device, ports: discovery.ports });
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
      await saveConfig(next);
      config = next;
      client?.updateConfig(config);
      deviceInfoCache = null;
      sendJson(response, 200, { ok: true, config });
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

function shutdown() {
  client?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
