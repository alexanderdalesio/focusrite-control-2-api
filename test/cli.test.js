import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'focusrite.js');

test('help groups commands and stays plain when redirected', async () => {
  const { stdout } = await run(process.execPath, [cli, 'help']);
  for (const heading of ['Control', 'Connection', 'Maintenance', 'Direct USB', 'Examples']) assert.match(stdout, new RegExp(`^${heading}$`, 'm'));
  assert.match(stdout, /service\s+install\|start\|stop\|restart\|status\|uninstall/);
  assert.doesNotMatch(stdout, /\u001b\[/);
});

test('forced terminal styling uses ANSI color', async () => {
  const { stdout } = await run(process.execPath, [cli, 'help'], { env: { ...process.env, FORCE_COLOR: '1' } });
  assert.match(stdout, /\u001b\[/);
});

test('JSON errors are valid machine-readable objects', async () => {
  await assert.rejects(
    run(process.execPath, [cli, 'toggle', '--json']),
    (error) => {
      const result = JSON.parse(error.stderr);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'Usage: focusrite toggle CONTROL');
      return true;
    },
  );
});

test('backend without an argument reports the selected communication method', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'focusrite-cli-test-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const { stdout } = await run(process.execPath, [cli, 'backend', '--json'], {
    env: {
      ...process.env,
      FOCUSRITE_API_URL: 'http://127.0.0.1:1',
      FOCUSRITE_DATA_DIR: dataDirectory,
    },
  });
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    backend: 'fc2',
    serviceRunning: false,
    connected: false,
  });
});

test('network status is disabled by default and never prints a token', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'focusrite-network-test-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const { stdout } = await run(process.execPath, [cli, 'network', 'status', '--json'], {
    env: { ...process.env, FOCUSRITE_DATA_DIR: dataDirectory },
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true, enabled: false, urls: [] });
});

test('control lists clearly label firmware-rejected read-only settings', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'focusrite-readonly-test-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const value = request.url === '/api/v1/health'
      ? { ok: true, api: version, backend: 'fc2' }
      : { controls: { 'metering-enabled': { kind: 'boolean', label: 'Front-panel meter feed', access: 'read-only' } } };
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { stdout } = await run(process.execPath, [cli, 'list'], {
    env: { ...process.env, NO_COLOR: '1', FOCUSRITE_DATA_DIR: dataDirectory, FOCUSRITE_API_URL: `http://127.0.0.1:${server.address().port}` },
  });
  assert.match(stdout, /metering-enabled\s+boolean\s+Front-panel meter feed · read-only/);
});

test('setting warnings are readable in text mode and structured in JSON mode', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'focusrite-warning-test-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const warning = { control: 'autogain-use-peak', code: 'notification-rejected', status: 7, verification: 'stored-value', message: 'Stored value verified; DSP effect remains experimental.' };
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/v1/health'
      ? { ok: true, api: version, backend: 'fc2' }
      : { ok: true, applied: 1, values: { 'autogain-use-peak': true }, warnings: [warning] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, NO_COLOR: '1', FOCUSRITE_DATA_DIR: dataDirectory, FOCUSRITE_API_URL: `http://127.0.0.1:${server.address().port}` };
  const plain = await run(process.execPath, [cli, 'set', 'autogain-use-peak', 'on'], { env });
  assert.match(plain.stdout, /autogain-use-peak\s+on/);
  assert.match(plain.stderr, /Warning: Stored value verified; DSP effect remains experimental/);
  assert.doesNotMatch(plain.stderr, /\u001b\[/);
  const json = await run(process.execPath, [cli, 'set', 'autogain-use-peak', 'on', '--json'], { env });
  assert.deepEqual(JSON.parse(json.stdout).warnings, [warning]);
  assert.equal(json.stderr, '');
});
