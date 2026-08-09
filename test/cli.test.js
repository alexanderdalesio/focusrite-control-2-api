import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'focusrite.js');

test('help groups commands and stays plain when redirected', async () => {
  const { stdout } = await run(process.execPath, [cli, 'help']);
  for (const heading of ['Control', 'Connection', 'Maintenance', 'Direct USB', 'Examples']) assert.match(stdout, new RegExp(`^${heading}$`, 'm'));
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
