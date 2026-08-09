import test from 'node:test';
import assert from 'node:assert/strict';
import { UsbApiClient } from '../src/usb/api-client.js';

test('routes direct USB operations through the persistent local API', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/device') return { device: { productName: 'Scarlett' } };
    if (path === '/api/v1/controls') return { controls: { dim: { kind: 'boolean' } } };
    if (path.endsWith('/get')) return { control: 'dim', value: true };
    if (path === '/api/v1/usb/led' && !options.method) return { supported: false, reason: 'Not supported.' };
    return { ok: true };
  };
  const client = new UsbApiClient(request);

  assert.deepEqual(await client.deviceInfo(), { productName: 'Scarlett' });
  assert.deepEqual(await client.controlDefinitions(), { dim: { kind: 'boolean' } });
  assert.deepEqual(await client.read(['dim']), { dim: true });
  assert.deepEqual(await client.ledInfo(), { supported: false, reason: 'Not supported.' });
  await client.setLed(3, '#123456');

  assert.equal(calls.at(-1).path, '/api/v1/usb/led');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { index: 3, color: '#123456' });

});
